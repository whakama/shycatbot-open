//requires
const fs = require('fs').promises
const crypto = require('crypto')
const util = require('util')
const config = require('../config.json')

//code
if (!config.cohost.use) return;
if (config.cohost.use && !config.cohost.password) return console.log('missing cohost password');
if (config.cohost.use && !config.cohost.email) return console.log('missing cohost email');
if (config.cohost.handle.startsWith('@')) config.cohost.handle = config.cohost.handle.substr(1);

const pbkdf2 = util.promisify(crypto.pbkdf2)
var done = function() {};

var cookie;

async function init() {
    var jsonBody = { '0': { email: config.cohost.email }}

    //get the salt from the server
    var saltData = await (await fetch(`https://cohost.org/api/v1/trpc/login.getSalt?batch=1&input=${encodeURIComponent(JSON.stringify(jsonBody))}`, {
        headers: {
            'User-Agent': config.userAgent
        }
    })).json()

    if (!saltData[0]?.result?.data?.salt) {
        console.log('cohost: failed to log in')
        return false;
    }

    //convert the salt to a buffer, from a base64 string
    var salt = Buffer.from(saltData[0].result.data.salt.replaceAll('-', 'A').replaceAll('_', 'A'), 'base64')

    var pbkdf2Parameters = {
        password: Buffer.from(config.cohost.password, 'utf-8'),
        salt,
        iterations: 2e5,
        keylen: 128,
        digest: 'sha384'
    }

    //hash the password
    var hashedPassword = await pbkdf2(pbkdf2Parameters.password, pbkdf2Parameters.salt, pbkdf2Parameters.iterations, pbkdf2Parameters.keylen, pbkdf2Parameters.digest)
    hashedPassword = hashedPassword.toString('base64')

    jsonBody[0].clientHash = hashedPassword;

    //log in with the hashed password
    var loginResponse = await fetch('https://cohost.org/api/v1/trpc/login.login?batch=1', {
        headers: {
            'Content-Type': 'application/json',
            'User-Agent': config.userAgent
        },
        method: 'POST',
        body: JSON.stringify(jsonBody)
    })

    var loginData = await loginResponse.json()

    if (loginData[0]?.result?.data?.userId) {
        cookie = loginResponse.headers.get('set-cookie')
        console.log(`cohost: logged in as userId ${loginData[0].result.data.userId} (${config.cohost.email})`)
        return true;
    } else {
        console.log('cohost: failed to log in')
        return false;
    }
}

async function post(fileName, filePath, mimeType) {
    try {
        var file = await fs.readFile(filePath)

        //create a post
        var postJson = {
            '0': {
                projectHandle: config.cohost.handle,
                content: {
                    postState: 1,
                    headline: fileName,
                    adultContent: false,
                    blocks: [
                        {
                            type: 'attachment',
                            attachment: {
                                attachmentId: '00000000-0000-0000-0000-000000000000',
                                altText: ''
                            }
                        }
                    ],
                    cws: [],
                    tags: []
                }
            }
        }

        var postCreate = await (await fetch('https://cohost.org/api/v1/trpc/posts.create?batch=1', {
            headers: {
                'Content-Type': 'application/json',
                'Cookie': cookie,
                'User-Agent': config.userAgent
            },
            method: 'POST',
            body: JSON.stringify(postJson)
        })).json()

        if (!postCreate[0]?.result?.data?.postId) throw `postCreate:${JSON.stringify(postCreate)}`;
        var postId = postCreate[0].result.data.postId

        //tell the cohost api about the attachment
        var attachmentStart = await (await fetch('https://cohost.org/api/v1/trpc/posts.attachment.start?batch=1', {
            headers: {
                'Content-Type': 'application/json',
                'Cookie': cookie,
                'User-Agent': config.userAgent
            },
            method: 'POST',
            body: JSON.stringify({
                '0': {
                    projectHandle: config.cohost.handle,
                    postId,
                    filename: fileName,
                    contentType: mimeType,
                    contentLength: file.length
                }
            })
        })).json()

        if (!attachmentStart[0]?.result?.data?.attachmentId) throw `attachmentStart:${JSON.stringify(attachmentStart)}`;
        var attachment = attachmentStart[0].result.data
        var attachmentId = attachment.attachmentId

        //construct the multipart form data
        var boundary = `shycatbotFormBoundary${crypto.randomBytes(8).toString('hex')}`
        var dataBound = ''

        for (let key of Object.keys(attachment.requiredFields)) {
            let value = attachment.requiredFields[key].replaceAll('"', '\\"')
            dataBound += `--${boundary}\r\n` +
            `Content-Disposition: form-data; name="${key}"\r\n\r\n` +
            `${value}\r\n`
        }

        var fileBound = `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="file"; filename="${fileName.replaceAll('"', '\\"')}"\r\n` +
        `Content-Type: ${mimeType}\r\n\r\n`

        var endBoundary = `\r\n--${boundary}--\r\n`;

        var bodyBuffer = Buffer.concat([ Buffer.from(dataBound), Buffer.from(fileBound), file, Buffer.from(endBoundary) ])

        //upload the multipart form data (including the file) to the cohost cdn
        var upload = await fetch('https://staging.cohostcdn.org/redcent-dev', {
            headers: {
                'Content-Type': `multipart/form-data; boundary=${boundary}`,
                'User-Agent': config.userAgent
            },
            method: 'POST',
            body: bodyBuffer
        })

        if (upload.status != 204) {
            let uploadData = await upload.text()
            throw `upload:${uploadData}`;
        }

        //tell the cohost api that the attachment is uploaded
        var attachmentFinish = await (await fetch('https://cohost.org/api/v1/trpc/posts.attachment.finish?batch=1', {
            headers: {
                'Content-Type': 'application/json',
                'Cookie': cookie,
                'User-Agent': config.userAgent
            },
            method: 'POST',
            body: JSON.stringify({
                '0': {
                    projectHandle: config.cohost.handle,
                    postId,
                    attachmentId
                }
            })
        })).json()

        if (!attachmentFinish[0]?.result?.data?.attachmentId) throw `attachmentFinish:${JSON.stringify(attachmentFinish)}`;

        //update the original post with the attachment id of our uploaded attachment
        postJson[0].content.blocks[0].attachment.attachmentId = attachmentId;
        postJson[0].postId = postId;

        var postUpdate = await fetch('https://cohost.org/api/v1/trpc/posts.update?batch=1', {
            headers: {
                'Content-Type': 'application/json',
                'Cookie': cookie,
                'User-Agent': config.userAgent
            },
            method: 'POST',
            body: JSON.stringify(postJson)
        })

        if (!postUpdate.ok) {
            let postUpdateData = await postUpdate.json()
            throw `postUpdate:${JSON.stringify(postUpdateData)}`;
        }

        done()
    } catch (err) {
        console.log(`cohost: failed to post ${fileName}`)
        console.error(err)
        done()
    }
}

module.exports.init = init;
module.exports.post = post;
module.exports.onDone = function(callback) {
    done = callback;
}
module.exports.isEnabled = function() {
    return config.cohost.use;
}