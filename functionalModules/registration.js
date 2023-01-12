const UserModule = require('../basicModules/users')
const CryptoJS = require("crypto-js");

async function main(db, data) {
  const collectionUsers = db.collection('users');
  const userMod = new UserModule(collectionUsers)
  const emailBusy = await userMod.findByEmail(data.email)
  if(emailBusy) {
    return JSON.stringify({error: "email занят", status: "error"})
  }
  const infoInDb = await userMod.create(data)
  return JSON.stringify({data: infoInDb, status: "ok"})
}

module.exports = async function (app, dbConnection, client)  {
  console.log('Connect registr')
  app.post('/api/signup', (req, res) => {
    const data = req.body
    data.password = CryptoJS.SHA256(data.password).toString();
    main(dbConnection, data)
      .then( (data) => res.send(data))
      .catch( (error) => res.send(error))
      .finally(() => client.close());
  })
};