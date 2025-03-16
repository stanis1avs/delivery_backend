// const mongoose = require('mongoose')

// const Schema = mongoose.Schema

// const advertisementSchema = new Schema({
//   shortText: {
//     type: String,
//     required: true,
//     unique: false
//   },
//   description: {
//     type: String,
//     unique: false
//   },
//   images: {
//     type: [String],
//     unique: false
//   },
//   userId: {
//     type: mongoose.ObjectId,
//     required: true,
//     unique: false
//   },
//   createdAt: {
//     type: Date,
//     required: true,
//     unique: false
//   },
//   updatedAt: {
//     type: Date,
//     required: true,
//     unique: false
//   },
//   tags: {
//     type: [String],
//     unique: false
//   },
//   isDeleted: {
//     type: Boolean,
//     required: true,
//     unique: false
//   },
// },{
//   versionKey: false
// })

// const Advertisement = mongoose.model('Advertisement', advertisementSchema)

// module.exports = Advertisement