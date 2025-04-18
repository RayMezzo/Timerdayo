const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const mongoose = require('mongoose');
const TimerModel = require('./models/Timer');


require("dotenv").config();

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
  },
});

mongoose.connect(
  process.env.MONGODB_URI
)
.then(() => console.log("db connected"))
.catch((err) => console.log(err));

const roomTimers = {}; // { roomId: { nextTimerId: 1, timers: { [timerId]: { count, interval, note } } } }
//roomTimersの構造
// const roomTimers = {
//   [roomId]: {
//     timers: {
//       [timerId]: {
//         count: Number,
//         interval: IntervalObject, // ← これは setInterval() の戻り値なので送れない
//         note: String
//       },
//       ...
//     }
//   },
//   ...
// }

//例:
// const roomTimers = {
//   "room123": {
//     timers: {
//       "timer1": {
//         count: 42,
//         interval: setInterval(...),  // ⚠️ JSONにできない！
//         note: "休憩タイマー"
//       },
//       "timer2": {
//         count: 100,
//         interval: setInterval(...),
//         note: "勉強タイマー"
//       }
//     }
//   },
//   "room456": {
//     timers: {
//       "timerA": {
//         count: 0,
//         interval: setInterval(...),
//         note: "別ルーム用タイマー"
//       }
//     }
//   }
// }




io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);

  socket.on('join_room', async(roomId) => {
    socket.join(roomId);
    console.log(`Client ${socket.id} joined room ${roomId}`);

    // ルームがまだ存在しない場合は初期化
    if (!roomTimers[roomId]) {
      roomTimers[roomId] = {
        nextTimerId: 1,
        timers: {},
      };
    }

    // MongoDBからルームのタイマーを取得し、roomTimers[roomId]に格納する。
    const timersFromDB = await TimerModel.find({ roomId });
    timersFromDB.forEach(timer => {
      roomTimers[roomId].timers[timer.timerId] = {
        count: timer.count,
        interval: null,
        note: timer.note,
      };
    });

    // ルームに存在するタイマーの情報を送信
    const timers = roomTimers[roomId].timers;
    // 修正：循環参照のない安全なデータだけ送る
    socket.emit('all_timers', Object.entries(timers).map(([timerId, timer]) => ({
      timerId,
      count: timer.count,
      note: timer.note || '',
      isRunning: timer.isRunning // 必要なら現在の状態も送れる
    })));

  });

  socket.on('leave_room', (roomId) => {
    socket.leave(roomId);
    console.log(`Client ${socket.id} left room ${roomId}`);
  });

  socket.on('create_timer', async({ roomId }) => {
    const room = roomTimers[roomId];
    if (!room) return;

    const timerId = room.nextTimerId.toString();
    room.nextTimerId++;

    const newTimer = {
      count: 0,
      interval: null,
      note: '',
    };
  
    room.timers[timerId] = newTimer;

    // MongoDBに保存
    await TimerModel.create({
      roomId,
      timerId,
      count: 0,
      note: '',
      isRunning: false
    });

    // タイマー作成時には他のクライアントに通知
    io.to(roomId).emit('timer_created', { timerId, count: 0, note: '' });
  });

  socket.on('resume_timer', ({ roomId, timerId }) => {
    const timer = roomTimers[roomId]?.timers[timerId];
    if (!timer || timer.interval) return;

    timer.interval = setInterval(() => {
      timer.count += 0.1;
      io.to(roomId).emit('timer_update', { timerId, count: timer.count });
    }, 100);

    io.to(roomId).emit('timer_status', { timerId, isRunning: true });
  });

  socket.on('stop_timer', async({ roomId, timerId }) => {
    const timer = roomTimers[roomId]?.timers[timerId];
    if (!timer || !timer.interval) return;

    clearInterval(timer.interval);
    timer.interval = null;

      // --- 追加: MongoDBに保存 ---
  try {
    await TimerModel.findOneAndUpdate(
      { roomId, timerId },
      {
        count: timer.count,
        isRunning: false,
      },
      { upsert: true } // ドキュメントが無い場合は新規作成
    );
    console.log(`Timer ${timerId} in room ${roomId} saved to DB`);
  } catch (err) {
    console.error(`Failed to save timer:`, err);
  }


    io.to(roomId).emit('timer_status', { timerId, isRunning: false });
  });

  socket.on('reset_timer', async({ roomId, timerId }) => {
    const timer = roomTimers[roomId]?.timers[timerId];
    if (!timer) return;
    timer.count = 0;


    // --- 追加: MongoDBに保存 ---
  try {
    await TimerModel.findOneAndUpdate(
      { roomId, timerId },
      {
        count: 0,
        isRunning: false, // リセット時は止まってる前提で false にする
      },
      { upsert: true }
    );
      console.log(`Timer ${timerId} in room ${roomId} reset and saved to DB`);
    } catch (err) {
      console.error(`Failed to save reset timer:`, err);
    }

    io.to(roomId).emit('timer_update', { timerId, count: 0 });
  });

  socket.on('delete_timer', async({ roomId, timerId }) => {
    const timer = roomTimers[roomId]?.timers[timerId];
    if (!timer) return;
  
    clearInterval(timer.interval);
    delete roomTimers[roomId].timers[timerId];
  
    await TimerModel.deleteOne({ roomId, timerId });
    io.to(roomId).emit('timer_deleted', timerId);
  });

  // メモを更新するイベント
  socket.on('update_note', async({ roomId, timerId, note }) => {
    const timer = roomTimers[roomId]?.timers[timerId];
    //これはオプショナルチェイニングっていって、
    //undefindの場合でも、エラーにならないようにするやつらしい。
    //roomidやtimerIdが無くてもundefinedが返るだけになる。
    //そして、timerがundefinedならreturn。
    if (!timer) return;

    timer.note = note;
    //noteを更新。

    
    await TimerModel.updateOne({ roomId, timerId }, { note });
    

    // メモが変更された場合のみ、他のクライアントに通知
    io.to(roomId).emit('note_updated', { timerId, note });
  });
});

server.listen(3001, () => {
  console.log('Socket.IO server running on http://localhost:3001');
});
