const mongoose = require('mongoose')

const Schema = mongoose.Schema

const userSchema = new Schema({
  email: {
    type: String,
    required: true,
  },
  password: {
    type: String,
    required: true,
    unique: false
  },
  name: {
    type: String,
    required: true,
    unique: false
  },
  contactPhone: {
    type: String,
    unique: false
  }
},{
  versionKey: false
})

const User = mongoose.model('User', userSchema)

module.exports = User