const Advertisements = require('../basicModules/advertisements')

async function getDB(db, id=null) {
  const collectionUsers = db.collection('advertisements');
  const advertisements = new Advertisements(collectionUsers)
  const infoInDb = await advertisements.find(id)
  return JSON.stringify({data: infoInDb, status: "ok"})
}

module.exports = async function (app, dbConnection, client)  {
  console.log('Connect AdvertSH')
  app.get('/api/advertisements', (req, res) => {
    getDB(dbConnection)
      .then( (data) => res.send(data))
      .catch( (error) => res.send(error))
  })

  app.get('/api/advertisements/:id', (req, res) => {
    getDB(dbConnection, req.params.id)
      .then( (data) => res.send(data))
      .catch( (error) => res.send(error))
  })
};