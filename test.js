var tape = require('tape')
var datDns = require('./index')()

var FAKE_DAT = 'f'.repeat(64)

tape('Successful test against pfrazee.hashbase.io', function (t) {
  datDns.resolveName('pfrazee.hashbase.io', function (err, name) {
    t.error(err)
    t.ok(/[0-9a-f]{64}/.test(name))

    datDns.resolveName('pfrazee.hashbase.io').then(function (name2) {
      t.equal(name, name2)
      t.end()
    })
  })
})

tape('A bad hostname fails gracefully', function (t) {
  datDns.resolveName('example.com', function (err, name) {
    t.ok(err)
    t.notOk(name)

    datDns.resolveName(1234, function (err, name) {
      t.ok(err)
      t.notOk(name)

      datDns.resolveName('foo bar', function (err, name) {
        t.ok(err)
        t.notOk(name)

        t.end()
      })
    })
  })
})

tape('Successful test against www.datprotocol.com', function (t) {
  datDns.resolveName('www.datprotocol.com', function (err, name) {
    t.error(err)
    t.ok(/[0-9a-f]{64}/.test(name))

    datDns.resolveName('www.datprotocol.com').then(function (name2) {
      t.equal(name, name2)
      t.end()
    })
  })
})
