var debug = require('debug')('dat')
var url = require('url')
var https = require('https')
var memoryCache = require('./cache')
var callMeMaybe = require('call-me-maybe')
var concat = require('concat-stream')

var DAT_HASH_REGEX = /^[0-9a-f]{64}?$/i
var VERSION_REGEX = /(\+[0-9]+)$/
var DEFAULT_DAT_DNS_TTL = 3600 // 1hr
var MAX_DAT_DNS_TTL = 3600 * 24 * 7 // 1 week

// helper to call promise-generating function
function maybe (cb, p) {
  if (typeof p === 'function') {
    p = p()
  }
  return callMeMaybe(cb, p)
}

module.exports = function (datDnsOpts) {
  datDnsOpts = datDnsOpts || {}
  var pCache = datDnsOpts.persistentCache
  var mCache = memoryCache()

  function resolveName (name, opts, cb) {
    if (typeof opts === 'function') {
      cb = opts
      opts = null
    }
    var ignoreCache = opts && opts.ignoreCache
    var ignoreCachedMiss = opts && opts.ignoreCachedMiss
    return maybe(cb, async function () {
      // parse the name as needed
      var nameParsed = url.parse(name)
      name = nameParsed.hostname || nameParsed.pathname

      // strip the version
      name = name.replace(VERSION_REGEX, '')

      // is it a hash?
      if (DAT_HASH_REGEX.test(name)) {
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

        // do a .well-known/dat lookup
        var res = await fetchWellKnownRecord(name)
        if (res.statusCode === 0 || res.statusCode === 404) {
          debug('.well-known/dat lookup failed for name:', name, res.statusCode, res.err)
          mCache.set(name, false, 60) // cache the miss for a minute
          throw new Error('DNS record not found')
        } else if (res.statusCode !== 200) {
          debug('.well-known/dat lookup failed for name:', name, res.statusCode)
          throw new Error('DNS record not found')
        }

        // parse the record
        var {key, ttl} = parseWellknownDatRecord(name, res.body)
        debug('.well-known/dat resolved', name, 'to', key)

        // cache
        if (ttl !== 0) mCache.set(name, key, ttl)
        if (pCache) pCache.write(name, key, ttl)

        return key
      } catch (err) {
        if (pCache) {
          // read from persistent cache on failure
          return pCache.read(name, err)
        }
        throw err
      }
    })
  }

  function listCache () {
    return mCache.list()
  }

  function flushCache () {
    mCache.flush()
  }

  return {
    resolveName: resolveName,
    listCache: listCache,
    flushCache: flushCache
  }
}

function fetchWellKnownRecord (name) {
  return new Promise((resolve, reject) => {
    debug('.well-known/dat lookup for name:', name)
    https.get({
      host: name,
      path: '/.well-known/dat',
      timeout: 2000
    }, function (res) {
      res.setEncoding('utf-8')
      res.pipe(concat(body => resolve({statusCode: res.statusCode, body})))
    }).on('error', function (err) {
      resolve({statusCode: 0, err, body: ''})
    })
  })
}

function parseWellknownDatRecord (name, body) {
  if (!body || typeof body != 'string') {
    throw new Error('DNS record not found')
  }

  const lines = body.split('\n')
  var key, ttl

  // parse url
  try {
    key = /^dat:\/\/([0-9a-f]{64})/i.exec(lines[0])[1]
  } catch (e) {
    debug('.well-known/dat failed', name, 'Must be a dat://{key} url')
    throw new Error('Invalid .well-known/dat record, must provide a dat://{key} url')
  }

  // parse ttl
  try {
    if (lines[1]) {
      ttl = +(/^ttl=(\d+)$/i.exec(lines[1])[1])
    }
  } catch (e) {
    debug('.well-known/dat failed to parse TTL for %s, line: %s, error:', name, lines[1], e)
  }
  if (!Number.isSafeInteger(ttl) || ttl < 0) {
    ttl = DEFAULT_DAT_DNS_TTL
  }
  if (ttl > MAX_DAT_DNS_TTL) {
    ttl = MAX_DAT_DNS_TTL
  }

  return {key, ttl}
}