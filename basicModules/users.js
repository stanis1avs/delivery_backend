module.exports = class UserModule {
  constructor(collection) {
    this.collection = collection;
  }

  async create(data) {
    const elem = await this.collection.insertOne(data)
    return {
      id: elem.insertedId,
      email: data.email,
      name: data.name,
      contactPhone: data.contactPhone
    }
  }

  async findByEmail(email) {
    const elem = await this.collection.findOne({email: email})
    if (elem){
      return elem
    }
    return null;
  }
};