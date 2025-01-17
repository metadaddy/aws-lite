let getEndpoint = require('./get-endpoint')
let getCreds = require('./get-creds')
let getRegion = require('./get-region')
let clientFactory = require('./client-factory')

/**
 * @param {object} [config] Client configuration options
 * @param {string} [config.accessKeyId] AWS access key; if not provided, defaults to `AWS_ACCESS_KEY_ID` or `AWS_ACCESS_KEY` env vars, and then to a `~/.aws/credentials` file, if present
 * @param {string} [config.secretAccessKey] AWS secret key; if not provided, defaults to `AWS_SECRET_ACCESS_KEY` or `AWS_SECRET_KEY` env var, and then to a `~/.aws/credentials` file, if present
 * @param {string} [config.sessionToken] AWS session token; if not provided, defaults to `AWS_SESSION_TOKEN` env var, and then to a `~/.aws/credentials` file, if present
 * @param {string} [config.region] AWS service region (e.g. `us-west-1`); if not provided, defaults to `AWS_REGION`, `AWS_DEFAULT_REGION`, or `AMAZON_REGION` env vars
 * @param {string} [config.profile='default'] AWS config + credentials profile; if not provided, defaults to `AWS_PROFILE` env var, and then to the `default` profile, if present
 * @param {boolean} [config.autoloadPlugins=true] Automatically load installed `@aws-lite/*` + `aws-lite-plugin-*` plugins
 * @param {boolean|string} [config.awsConfigFile=false] Load configuration via ~/.aws/config (boolean), or via a passed file path
 * @param {boolean} [config.debug] Enable debug logging to console
 * @param {string} [config.pathPrefix] Add a path prefix to requests, helpful for local testing
 * @param {string} [config.host] Set a custom host name to use, helpful for local testing
 * @param {boolean} [config.keepAlive=true] Disable Node.js's connection keep-alive, helpful for local testing
 * @param {array} [config.plugins] Manually define plugins to load; by default, `@aws-lite/*` + `aws-lite-plugin-*` plugins are auto-loaded
 * @param {number} [config.port] Set a custom port number to use, helpful for local testing
 * @param {string} [config.protocol='https'] Set the connection protocol to 'http', helpful for local testing
 * @param {string} [config.responseContentType] Set an overriding Content-Type headers for responses, helpful for local testing
 *
 * @returns {Promise<function>} Client async function
 */
module.exports = async function awsLite (config = {}) {
  // Set defaults + essential config
  config.profile = config.profile || process.env.AWS_PROFILE || 'default'
  config = { ...config, ...(await getEndpoint(config)) }

  // Creds + region
  let creds = await getCreds(config)
  let region = await getRegion(config)

  // Validate, then go
  validateConfig(config)
  return await clientFactory(config, creds, region)
}

function validateConfig (config) {
  if (config.plugins && !Array.isArray(config.plugins)) {
    throw TypeError('Plugins must be an array')
  }
}
