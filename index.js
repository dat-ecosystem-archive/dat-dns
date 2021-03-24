const debug = require('debug')('dat')
const url = require('url')
const https = require('https')
const Emitter = require('events')
const { stringify } = require('querystring')
const memoryCache = require('./cache')
const callMeMaybe = require('call-me-maybe')
const concat = require('concat-stream')

const DAT_HASH_REGEX = /^[0-9a-f]{64}?$/i
const DAT_PROTOCOL_REGEX = /^dat:\/\/([0-9a-f]{64})/i
const DAT_RECORD_NAME = 'dat'
const DAT_TXT_REGEX = /"?datkey=([0-9a-f]{64})"?/i
const VERSION_REGEX = /(\+[^\/]+)$/
const DEFAULT_DAT_DNS_TTL = 3600 // 1hr
const MAX_DAT_DNS_TTL = 3600 * 24 * 7 // 1 week
const DEFAULT_DNS_PROVIDERS = [['cloudflare-dns.com', 443, '/dns-query'], ['dns.google', 443, '/resolve']]

module.exports = createDatDNS

// helper to support node6
function _asyncToGenerator (fn) { return function () { var gen = fn.apply(this, arguments); return new Promise(function (resolve, reject) { function step (key, arg) { try { var info = gen[key](arg); var value = info.value } catch (error) { reject(error); return } if (info.done) { resolve(value) } else { return Promise.resolve(value).then(function (value) { step('next', value) }, function (err) { step('throw', err) }) } } return step('next') }) } }

// helper to call promise-generating function
function maybe (cb, p) {
  if (typeof p === 'function') {
    p = p()
  }
  return callMeMaybe(cb, p)
}

function createDatDNS (datDnsOpts) {
  datDnsOpts = datDnsOpts || {}
  if (datDnsOpts.hashRegex && !(datDnsOpts.hashRegex instanceof RegExp)) { throw new Error('opts.hashRegex must be a RegExp object') }
  if (datDnsOpts.txtRegex && !(datDnsOpts.txtRegex instanceof RegExp)) { throw new Error('opts.txtRegex must be a RegExp object') }
  if (datDnsOpts.protocolRegex && !(datDnsOpts.protocolRegex instanceof RegExp)) { throw new Error('opts.protocolRegex must be a RegExp object') }
  var hashRegex = datDnsOpts.hashRegex || DAT_HASH_REGEX
  var dnsTxtRegex = datDnsOpts.txtRegex || DAT_TXT_REGEX
  var protocolRegex = datDnsOpts.protocolRegex || DAT_PROTOCOL_REGEX
  var recordName = datDnsOpts.recordName || DAT_RECORD_NAME
  var pCache = datDnsOpts.persistentCache
  var mCache = memoryCache()
  mCache.init({
    ttl: 60,
    interval: datDnsOpts.cacheCleanSeconds || 60,
  });
  var dnsHost
  var dnsPort
  var dnsPath
  if (!datDnsOpts.dnsHost || !datDnsOpts.dnsPath) {
    let dnsProvider = DEFAULT_DNS_PROVIDERS[Math.floor(Math.random() * DEFAULT_DNS_PROVIDERS.length)]
    dnsHost = dnsProvider[0]
    dnsPort = dnsProvider[1]
    dnsPath = dnsProvider[2]
  } else {
    dnsHost = datDnsOpts.dnsHost
    dnsPort = datDnsOpts.dnsPort || 443
    dnsPath = datDnsOpts.dnsPath
  }

  var datDns = new Emitter()

  function resolveName (name, opts, cb) {
    if (typeof opts === 'function') {
      cb = opts
      opts = null
    }
    var ignoreCache = opts && opts.ignoreCache
    var ignoreCachedMiss = opts && opts.ignoreCachedMiss
    var noDnsOverHttps = opts && opts.noDnsOverHttps
    var noWellknownDat = opts && opts.noWellknownDat
    return maybe(cb, _asyncToGenerator(function * () {
      // parse the name as needed
      var nameParsed = url.parse(name)
      name = nameParsed.hostname || nameParsed.pathname

      // strip the version
      name = name.replace(VERSION_REGEX, '')

      // is it a hash?
      if (hashRegex.test(name)) {
        return name.slice(0, 64)
      }

      try {
        // check the cache
        if (!ignoreCache) {
          const cachedKey = mCache.get(name)
          if (typeof cachedKey !== 'undefined') {
            if (cachedKey || (!cachedKey && !ignoreCachedMiss)) {
              debug('In-memory cache hit for name', name, cachedKey)
              if (cachedKey) return cachedKey
              else throw new Error('DNS record not found') // cached miss
            }
          }
        }

        var res
        if (!noDnsOverHttps) {
          try {
            // do a DNS-over-HTTPS lookup
            res = yield fetchDnsOverHttpsRecord(datDns, name, { host: dnsHost, port: dnsPort, path: dnsPath })

            // parse the record
            res = parseDnsOverHttpsRecord(datDns, name, res.body, dnsTxtRegex)
            datDns.emit('resolved', {
              method: 'dns-over-https',
              name,
              key: res.key
            })
            debug('dns-over-http resolved', name, 'to', res.key)
          } catch (e) {
            // ignore, we'll try .well-known/`${recordName}` next
            res = false
          }
        }

        if (!res && !noWellknownDat) {
          // do a .well-known/`${recordName}` lookup
          res = yield fetchWellKnownRecord(name, recordName)
          if (res.statusCode === 0 || res.statusCode === 404) {
            debug('.well-known/' + recordName + ' lookup failed for name:', name, res.statusCode, res.err)
            datDns.emit('failed', {
              method: 'well-known',
              name,
              err: 'HTTP code ' + res.statusCode + ' ' + res.err
            })
            mCache.set(name, false, 60) // cache the miss for a minute
            throw new Error('DNS record not found')
          } else if (res.statusCode !== 200) {
            debug('.well-known/' + recordName + ' lookup failed for name:', name, res.statusCode)
            datDns.emit('failed', {
              method: 'well-known',
              name,
              err: 'HTTP code ' + res.statusCode
            })
            throw new Error('DNS record not found')
          }

          // parse the record
          res = parseWellknownDatRecord(datDns, name, res.body, protocolRegex, recordName)
          datDns.emit('resolved', {
            method: 'well-known',
            name,
            key: res.key
          })
          debug('.well-known/' + recordName + ' resolved', name, 'to', res.key)
        }

        // cache
        if (res.ttl !== 0) mCache.set(name, res.key, res.ttl)
        if (pCache) pCache.write(name, res.key, res.ttl)

        return res.key
      } catch (err) {
        if (pCache) {
          // read from persistent cache on failure
          return pCache.read(name, err)
        }
        throw err
      }
    }))
  }

  function listCache () {
    return mCache.list()
  }

  function flushCache () {
    datDns.emit('cache-flushed')
    mCache.flush()
  }

  datDns.resolveName = resolveName
  datDns.listCache = listCache
  datDns.flushCache = flushCache
  return datDns
}

createDatDNS.DEFAULT_DNS_PROVIDERS = DEFAULT_DNS_PROVIDERS

function fetchDnsOverHttpsRecord (datDns, name, { host, port, path }) {
  return new Promise((resolve, reject) => {
    // ensure the name is a FQDN
    if (!name.includes('.')) {
      debug('dns-over-https failed', name, 'Not an a FQDN')
      datDns.emit('failed', {
        method: 'dns-over-https',
        name,
        err: 'Name is not a FQDN'
      })
      reject(new Error('Domain is not a FQDN.'))
    } else if (!name.endsWith('.')) {
      name = name + '.'
    }
    var query = {
      name,
      type: 'TXT'
    }
    debug('dns-over-https lookup for name:', name, 'at', host + ':' + port + path)
    https.get({
      host,
      port,
      path: `${path}?${stringify(query)}`,
      // Cloudflare requires this exact header; luckily everyone else ignores it
      headers: {
        'Accept': 'application/dns-json'
      },
      timeout: 2000
    }, function (res) {
      res.setEncoding('utf-8')
      res.pipe(concat(body => resolve({ statusCode: res.statusCode, body })))
    }).on('error', function (err) {
      resolve({ statusCode: 0, err, body: '' })
    })
  })
}

function parseDnsOverHttpsRecord (datDns, name, body, dnsTxtRegex) {
  // decode to obj
  var record
  try {
    record = JSON.parse(body)
  } catch (e) {
    debug('dns-over-https failed', name, 'did not give a valid JSON response', body)
    datDns.emit('failed', {
      method: 'dns-over-https',
      name,
      err: 'Failed to parse JSON response'
    })
    throw new Error('Invalid dns-over-https record, must provide json')
  }

  // find valid answers
  var answers = record['Answer']
  if (!answers || !Array.isArray(answers)) {
    debug('dns-over-https failed', name, 'did not give any answers')
    datDns.emit('failed', {
      method: 'dns-over-https',
      name,
      err: 'Did not give any TXT answers'
    })
    throw new Error('Invalid dns-over-https record, no answers given')
  }
  answers = answers.filter(a => {
    if (!a || typeof a !== 'object') {
      return false
    }
    if (typeof a.data !== 'string') {
      return false
    }
    var match = dnsTxtRegex.exec(a.data)
    if (!match) {
      return false
    }
    a.key = match[1]
    return true
  })
    // Open DNS servers are not consistent in the ordering of TXT entries.
    // In order to have a consistent behavior we sort keys in case we find multiple.
    .sort((a, b) => a.key < b.key ? 1 : a.key > b.key ? -1 : 0)
  if (!answers[0]) {
    debug('dns-over-https failed', name, 'did not give any TXT answers')
    datDns.emit('failed', {
      method: 'dns-over-https',
      name,
      err: 'Did not give any TXT answers'
    })
    throw new Error('Invalid dns-over-https record, no TXT answer given')
  }

  // put together res
  var res = { key: answers[0].key, ttl: answers[0].TTL }
  if (!Number.isSafeInteger(res.ttl) || res.ttl < 0) {
    res.ttl = DEFAULT_DAT_DNS_TTL
  }
  if (res.ttl > MAX_DAT_DNS_TTL) {
    res.ttl = MAX_DAT_DNS_TTL
  }
  return res
}

function fetchWellKnownRecord (name, recordName) {
  return new Promise((resolve, reject) => {
    debug('.well-known/dat lookup for name:', name)
    https.get({
      host: name,
      path: '/.well-known/' + recordName,
      timeout: 2000
    }, function (res) {
      res.setEncoding('utf-8')
      res.pipe(concat(body => resolve({ statusCode: res.statusCode, body })))
    }).on('error', function (err) {
      resolve({ statusCode: 0, err, body: '' })
    })
  })
}

function parseWellknownDatRecord (datDns, name, body, protocolRegex, recordName) {
  if (!body || typeof body !== 'string') {
    datDns.emit('failed', {
      method: 'well-known',
      name,
      err: 'Empty response'
    })
    throw new Error('DNS record not found')
  }

  const lines = body.split('\n')
  var key, ttl

  // parse url
  try {
    key = protocolRegex.exec(lines[0])[1]
  } catch (e) {
    debug('.well-known/' + recordName + ' failed', name, 'must conform to ' + protocolRegex)
    datDns.emit('failed', {
      method: 'well-known',
      name,
      err: 'Record did not conform to ' + protocolRegex
    })
    throw new Error('Invalid .well-known/' + recordName + ' record, must conform to' + protocolRegex)
  }

  // parse ttl
  try {
    if (lines[1]) {
      ttl = +(/^ttl=(\d+)$/i.exec(lines[1])[1])
    }
  } catch (e) {
    datDns.emit('failed', {
      method: 'well-known',
      name,
      err: 'Failed to parse TTL line, error: ' + e.toString()
    })
    debug('.well-known/' + recordName + ' failed to parse TTL for %s, line: %s, error:', name, lines[1], e)
  }
  if (!Number.isSafeInteger(ttl) || ttl < 0) {
    ttl = DEFAULT_DAT_DNS_TTL
  }
  if (ttl > MAX_DAT_DNS_TTL) {
    ttl = MAX_DAT_DNS_TTL
  }

  return { key, ttl }
}
