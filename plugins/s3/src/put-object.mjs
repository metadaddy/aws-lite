import aws4 from 'aws4'
import crypto from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { Readable } from 'node:stream'

const required = true
const chunkBreak = `\r\n`
const minSize = 1024 * 1024 * 5
const intToHexString = int => String(Number(int).toString(16))
const algo = 'sha256', utf8 = 'utf8', hex = 'hex'
const hash = str => crypto.createHash(algo).update(str, utf8).digest(hex)
const hmac = (key, str, enc) => crypto.createHmac(algo, key).update(str, utf8).digest(enc)

function payloadMetadata (chunkSize, signature) {
  // Don't forget: after the signature + break would normally follow the body + one more break
  return intToHexString(chunkSize) + `;chunk-signature=${signature}` + chunkBreak
}

// Commonly used headers
const comment = header => `Sets request header: \`${header}\``
const getValidateHeaders = (...headers) => headers.reduce((acc, h) => {
  if (!headerMappings[h]) throw ReferenceError(`Header not found: ${h}`)
  acc[h] = { type: 'string', comment: comment(headerMappings[h]) }
  return acc
}, {})
// The !x-amz headers are documented by AWS as old school pascal-case headers; lowcasing them to be HTTP 2.0 compliant
const headerMappings = {
  ACL:                        'x-amz-acl',
  BucketKeyEnabled:           'x-amz-server-side-encryption-bucket-key-enabled',
  CacheControl:               'cache-control',
  ChecksumAlgorithm:          'x-amz-sdk-checksum-algorithm',
  ChecksumCRC32:              'x-amz-checksum-crc32',
  ChecksumCRC32C:             'x-amz-checksum-crc32c',
  ChecksumSHA1:               'x-amz-checksum-sha1',
  ChecksumSHA256:             'x-amz-checksum-sha256',
  ContentDisposition:         'content-disposition',
  ContentEncoding:            'content-encoding',
  ContentLanguage:            'content-language',
  ContentLength:              'content-length',
  ContentMD5:                 'content-md5',
  ContentType:                'content-type',
  ETag:                       'etag',
  ExpectedBucketOwner:        'x-amz-expected-bucket-owner',
  Expiration:                 'x-amz-expiration',
  Expires:                    'expires',
  GrantFullControl:           'x-amz-grant-full-control',
  GrantRead:                  'x-amz-grant-read',
  GrantReadACP:               'x-amz-grant-read-acp',
  GrantWriteACP:              'x-amz-grant-write-acp',
  ObjectLockLegalHoldStatus:  'x-amz-object-lock-legal-hold',
  ObjectLockMode:             'x-amz-object-lock-mode',
  ObjectLockRetainUntilDate:  'x-amz-object-lock-retain-until-date',
  RequestCharged:             'x-amz-request-charged',
  RequestPayer:               'x-amz-request-payer',
  ServerSideEncryption:       'x-amz-server-side-encryption',
  SSECustomerAlgorithm:       'x-amz-server-side-encryption-customer-algorithm',
  SSECustomerKey:             'x-amz-server-side-encryption-customer-key',
  SSECustomerKeyMD5:          'x-amz-server-side-encryption-customer-key-md5',
  SSEKMSEncryptionContext:    'x-amz-server-side-encryption-context',
  SSEKMSKeyId:                'x-amz-server-side-encryption-aws-kms-key-id',
  StorageClass:               'x-amz-storage-class',
  Tagging:                    'x-amz-tagging',
  VersionId:                  'x-amz-version-id',
  WebsiteRedirectLocation:    'x-amz-website-redirect-location',
}
// Invert above for header lookups
const paramMappings = Object.fromEntries(Object.entries(headerMappings).map(([ k, v ]) => [ v, k ]))
const quoted = /^".*"$/
const ignoreHeaders = [ 'content-length' ]
const parseHeadersToResults = ({ headers }) => {
  let results = Object.entries(headers).reduce((acc, [ header, value ]) => {
    const normalized = header.toLowerCase()
    if (value.match(quoted)) {
      value = value.substring(1, value.length - 1)
    }
    if (paramMappings[normalized] && !ignoreHeaders.includes(normalized)) {
      acc[paramMappings[normalized]] = value
    }
    return acc
  }, {})
  return results
}

const PutObject = {
  awsDoc: 'https://docs.aws.amazon.com/AmazonS3/latest/API/API_PutObject.html',
  // See also: https://docs.aws.amazon.com/AmazonS3/latest/API/sigv4-streaming.html
  validate: {
    Bucket:                    { type: 'string', required, comment: 'S3 bucket name' },
    Key:                       { type: 'string', required, comment: 'S3 key / file name' },
    File:                      { type: 'string', required, comment: 'File path to be read and uploaded from the local filesystem' },
    MinChunkSize:              { type: 'number', default: minSize, comment: 'Minimum size (in bytes) to utilize AWS-chunk-encoded uploads to S3' },
    // Here come the headers
    ...getValidateHeaders('ACL', 'BucketKeyEnabled', 'CacheControl', 'ChecksumAlgorithm', 'ChecksumCRC32',
      'ChecksumCRC32C', 'ChecksumSHA1', 'ChecksumSHA256', 'ContentDisposition', 'ContentEncoding',
      'ContentLanguage', 'ContentLength', 'ContentMD5', 'ContentType', 'ExpectedBucketOwner', 'Expires',
      'GrantFullControl', 'GrantRead', 'GrantReadACP', 'GrantWriteACP', 'ObjectLockLegalHoldStatus',
      'ObjectLockMode', 'ObjectLockRetainUntilDate', 'RequestPayer', 'ServerSideEncryption',
      'SSECustomerAlgorithm', 'SSECustomerKey', 'SSECustomerKeyMD5', 'SSEKMSEncryptionContext',
      'SSEKMSKeyId', 'StorageClass', 'Tagging', 'WebsiteRedirectLocation')
  },
  request: async (params, utils) => {
    let { Bucket, Key, File, MinChunkSize } = params
    let { credentials, region } = utils
    MinChunkSize = MinChunkSize || minSize

    let headers = Object.keys(params).reduce((acc, param) => {
      if (headerMappings[param]) {
        acc[headerMappings[param]] = params[param]
      }
      return acc
    }, {})

    let dataSize
    try {
      let stats = await stat(File)
      dataSize = stats.size
    }
    catch (err) {
      console.log(`Error reading file: ${File}`)
      throw err
    }

    if (dataSize <= MinChunkSize) {
      let payload = await readFile(File)
      return {
        path: `/${Bucket}/${Key}`,
        method: 'PUT',
        headers,
        payload,
      }
    }
    else {
      // We'll assemble file indices of chunks here
      let chunks = [
        // Reminder: no payload is sent with the canonical request
        { canonicalRequest: true },
      ]

      // We'll need to compute all chunk sizes (including metadata) so that we can get the total content-length for the canonical request
      let totalRequestSize = dataSize
      let dummySig = 'a'.repeat(64)
      let emptyHash = hash('')

      // Multipart uploading requires an extra zero-data chunk to denote completion
      let chunkAmount = Math.ceil(dataSize / MinChunkSize) + 1

      for (let i = 0; i < chunkAmount; i++) {
        // Get start end byte position for streaming
        let start = i === 0 ? 0 : i * MinChunkSize
        let end = (i * MinChunkSize) + MinChunkSize

        let chunk = {}, chunkSize
        // The last real chunk
        if (end > dataSize) {
          end = dataSize
        }
        // The 0-byte trailing chunk
        if (start > dataSize) {
          chunkSize = 0
          chunk.finalRequest = true
        }
        // Normal
        else {
          chunkSize = end - start
          chunk.start = start
          chunk.end = end
        }

        totalRequestSize += payloadMetadata(chunkSize, dummySig).length + chunkBreak.length
        chunks.push({ ...chunk, chunkSize })
      }

      headers = {
        ...headers,
        'content-encoding': 'aws-chunked',
        'content-length': totalRequestSize,
        'x-amz-content-sha256': 'STREAMING-AWS4-HMAC-SHA256-PAYLOAD',
        'x-amz-decoded-content-length': dataSize,
      }
      let canonicalReq = aws4.sign({
        service: 's3',
        region,
        method: 'PUT',
        path: `/${Bucket}/${Key}`,
        headers,
      }, credentials)
      let seedSignature = canonicalReq.headers.Authorization.split('Signature=')[1]
      chunks[0].signature = seedSignature

      let date = canonicalReq.headers['X-Amz-Date'] ||
                 canonicalReq.headers['x-amz-date']
      let yyyymmdd = date.split('T')[0]
      let payloadSigHeader =  `AWS4-HMAC-SHA256-PAYLOAD\n` +
                              `${date}\n` +
                              `${yyyymmdd}/${canonicalReq.region}/s3/aws4_request\n`

      // TODO make this streamable
      let data = await readFile(File)
      let stream = new Readable()
      chunks.forEach((chunk, i) => {
        if (chunk.canonicalRequest) return

        // Ideally we'd use start/end with fs.createReadStream
        let { start, end } = chunk
        let body = chunk.finalRequest ? '' : data.slice(start, end)
        let chunkHash = chunk.finalRequest ? emptyHash : hash(body)

        let payloadSigValues = [
          chunks[i - 1].signature, // Previous chunk signature
          emptyHash,               // Hash of an empty line ¯\_(ツ)_/¯
          chunkHash,               // Hash of the current chunk
        ].join('\n')
        let signing = payloadSigHeader + payloadSigValues

        // lol at this cascade of hmacs
        let kDate = hmac('AWS4' + credentials.secretAccessKey, yyyymmdd)
        let kRegion = hmac(kDate, region)
        let kService = hmac(kRegion, 's3')
        let kCredentials = hmac(kService, 'aws4_request')
        let chunkSignature = hmac(kCredentials, signing, hex)

        // Important: populate the signature for the next chunk down the line
        chunks[i].signature = chunkSignature

        // Now add the chunk to the stream
        let part = payloadMetadata(chunk.chunkSize, chunkSignature) + body + chunkBreak
        stream.push(part)

        if (chunk.finalRequest) {
          stream.push(null)
        }
      })
      canonicalReq.payload = stream
      return canonicalReq
    }
  },
  response: parseHeadersToResults,
}
export default PutObject
