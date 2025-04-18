const mongoose = require('mongoose');

const TimerSchema = new mongoose.Schema({
  roomId: String,
  timerId: String,
  count: Number,
  note: String,
  isRunning: Boolean
});

module.exports = mongoose.model('Timer', TimerSchema);
