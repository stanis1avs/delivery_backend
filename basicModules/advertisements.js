const ObjectId = require('mongodb').ObjectId;

module.exports = class Advertisements {
  constructor(collection) {
    this.collection = collection;
  }

  async create(data) {
    const elem = await this.collection.insertOne(data)
    return {
      id: elem.insertedId,
      description: data.description,
      shortTitle: data.shortText,
      images: data.images,
      user: {
        id: data.userId,
        name: data.description
      },
      createdAt: data.createdAt
    }
  }

  async remove(id, userId) {
    const idDb = new ObjectId(id)
    const advert = await this.collection.findOne({ _id: idDb })
    if (advert.userId == userId){
      const data = await this.collection.updateOne({ _id: idDb }, { $set: {isDeleted: true}})
      return {userId: advert.userId}
    }
    return null
  }

  async find(id) {
    if (id) {
      const idDb = new ObjectId(id)
      const elem = await this.collection.findOne({_id: idDb, isDeleted: false})
      return elem ?? []
    }
    else {
      const elems = await this.collection.find({isDeleted: false}).toArray()
      return elems ?? []
    }
  }
};