const Advertisements = require('../basicModules/advertisements')
const UserModule = require('../basicModules/users')
const multer  = require('multer')
const upload = multer({ dest: 'uploads/' })

async function addToDB(db, data) {
  const collectionUsers = db.collection('advertisements');
  const advertisement = new Advertisements(collectionUsers)
  const infoInDb = await advertisement.create(data)
  return JSON.stringify({data: infoInDb, status: "ok"})
}

async function deleteFromDB(db, id, userId) {
  const collectionUsers = db.collection('advertisements');
  const advertisement = new Advertisements(collectionUsers)
  const infoInDb = await advertisement.remove(id, userId)
  if (!infoInDb){
    return JSON.stringify({error: "Вы не можете удалить объявление", status: 403})
  }
  return JSON.stringify({data: infoInDb, status: "ok"})
}

const auth = (req, res, next) => {
  if (req.isAuthenticated()) {
    next();
  } else {
    return res.send(JSON.stringify({error: "Вы не прошли ауентификацию", status: 401}))
  }
};

module.exports = async function (app, dbConnection, client)  {
  console.log('Connect advertCr')
  app.post('/api/advertisements', auth, upload.array('images'), (req, res) => {
    const data = {
      shortText: req.body.shortTitle,
      description: req.body.description,
      images: req.files.map(el => el.path),
      userId: req.user.id,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      tags: req.files.map(el => el.originalname),
      isDeleted: false
    }
    console.log(data)
    addToDB(dbConnection, data)
      .then( (data) => res.send(data))
      .catch( (error) => res.send(error))
  })

  app.delete('/api/advertisements/:id', auth, (req, res) => {
    deleteFromDB(dbConnection, req.params.id, req.user.id)
      .then( (data) => res.send(data))
      .catch( (error) => res.send(error))
  })
};