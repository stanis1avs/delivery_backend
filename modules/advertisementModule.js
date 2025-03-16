const Advertisement = require('../models/advertisement')
const User = require('../models/user')

module.exports = class AdvertisementModule {
  static async create(data, files, user) {
    const {description, shortTitle: shortText} = data
    const userId = user._id

    if (shortText) {
      try {
        const advertisementSent = new Advertisement({
        description, shortText, userId,
        images: files.map(el => el.path) ?? [], 
        tags: files.map(el => el.originalname) ?? [], 
        isDeleted: false, 
        createdAt: new Date().toISOString(), 
        updatedAt: new Date().toISOString()})

        const advertisementToDb = await advertisementSent.save()

        const advertisementFormat = await AdvertisementModule.formatAdvertisement(advertisementToDb)
        return advertisementFormat
      } catch(e) {

        return new Error(e)
      }
    }

    else {
      return "invalid data"
    }
  }

  static async find(params = null) {
    try {
      if (params) {
        const elem = await Advertisement.findById(params)
        if (!elem.isDeleted) {
          return await AdvertisementModule.formatAdvertisement(elem)
        }
        else {
          return []
        }
      }
      const elems = await Advertisement.find()
      const elemsFilter = elems.filter(el => el.isDeleted === false)

      const elemsFormat = []

      for (const el of elemsFilter) {
        elemsFormat.push(await AdvertisementModule.formatAdvertisement(el))
      }

      return elemsFormat
    } catch(e) {

      return new Error(e)
    }
  }

  static async remove (idAdvert, idUser) {
    try {
      const elem = await Advertisement.findById(idAdvert)

      if(String(elem.userId) == String(idUser)) {
        await Advertisement.findByIdAndUpdate(idAdvert, {isDeleted: true})

        return
      }

      return "You don't remove this advertisement"
    } catch(e) {
      return new Error(e)
    }
  }

  static async formatAdvertisement (data) {
    const userId = await User.findById(data.userId)
    return {
      id: data._id,
      description: data.description,
      shortTitle: data.shortText,
      images: data.images,
      user: {
        id: data.userId,
        name: userId.email
      },
      createdAt: data.createdAt
    }
  }
}