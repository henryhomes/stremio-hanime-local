const pUrl = require('url')

const { config, proxy } = require('internal')

const needle = require('needle')

const defaults = {
	name: 'Hentai from hanime',
	prefix: 'hanime_',
	origin: '',
	endpoint: 'https://hanime.tv',
	icon: 'https://img.android-apk.org/imgs/3/9/6/3963a4a6ae1e14f9824fc89f57bc5a17.png',
	categories: []
}

let endpoint = defaults.endpoint

const headers = {
	'accept': 'application/json, text/plain, */*',
	'accept-language': 'en-GB,en-US;q=0.9,en;q=0.8',
	'referer': endpoint,
	'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_13_6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/73.0.3683.103 Safari/537.36',
	'x-directive': 'api',
	'x-session-token': '', 
	'x-signature': '',
	'x-time': '0'
}

function setEndpoint(str) {
	if (str) {
		let host = str
		if (host.endsWith('/index.php'))
			host = host.replace('/index.php', '/')
		if (!host.endsWith('/'))
			host += '/'
		endpoint = host
		const origin = endpoint.replace(pUrl.parse(endpoint).path, '')
		headers['origin'] = origin
		headers['referer'] = endpoint + '/'
	}
	return true
}

setEndpoint(config.host || defaults.endpoint)

let genres = []

function getGenres(cb) {
	needle.get(endpoint + 'api/v3/browse', { headers }, (err, resp, body) => {
		if ((body || {}).hentai_tags)
			genres = body.hentai_tags.map(el => { return el.text })
		cb()
	})
}

function retrieveManifest() {
	function manifest() {
		return {
			id: 'org.' + defaults.name.toLowerCase().replace(/[^a-z]+/g,''),
			version: '1.0.0',
			name: defaults.name,
			description: 'Hentai (anime porn) streams from hanime. This add-on works better in Stremio desktop app then the web version.',
			resources: ['stream', 'meta', 'catalog'],
			types: ['movie'],
			idPrefixes: [defaults.prefix],
			icon: defaults.icon,
			catalogs: [
				{
					id: defaults.prefix + 'catalog',
					type: 'movie',
					name: defaults.name,
					genres,
					extra: [{ name: 'genre' }, { name: 'skip' }, { name: 'search' }]
				}
			]
		}
	}

	return new Promise((resolve, reject) => {
		getGenres(() => { resolve(manifest()) })
	})
}

function toMeta(obj, tags) {
	const meta = {
		id: defaults.prefix + obj.slug,
		name: obj.name,
		type: 'movie',
		poster: obj.cover_url,
		background: obj.poster_url,
		runtime: obj.is_censored ? 'CENSORED' : 'UNCENSORED',
		description: obj.description || ''
	}
	if (tags && Array.isArray(tags) && tags.length)
		meta.genres = tags.map(el => { return el.text })
	return meta
}

async function retrieveRouter() {
	const manifest = await retrieveManifest()

	const { addonBuilder, getInterface, getRouter } = require('stremio-addon-sdk')

	const builder = new addonBuilder(manifest)

	builder.defineCatalogHandler(args => {
		return new Promise((resolve, reject) => {
			const extra = args.extra || {}
			if (extra.genre) {
				const page = extra.skip ? (extra.skip / 24) : '0'
				needle.get(endpoint + 'api/v3/browse/hentai-tags/' + encodeURIComponent(extra.genre) + '?page=' + page + '&order_by=created_at_unix&ordering=desc', { headers }, (err, resp, body) => {
					if (((body || {}).hentai_videos || []).length) {
						resolve({ metas: body.hentai_videos.map(toMeta) })
					} else
						reject(defaults.name + ' - No videos in catalog for genre: ' + extra.genre)
				})
			} else if (extra.search) {
				const payload = {"search_text":extra.search,"tags":[],"tags_mode":"AND","brands":[],"blacklist":[],"order_by":"created_at_unix","ordering":"desc","page":0}
				const searchHeaders = {
					'accept': 'application/json, text/plain, */*',
					'content-type': 'application/json;charset=UTF-8',
					'origin': headers.origin,
					'referer': headers.referer,
					'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_13_6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/73.0.3683.103 Safari/537.36'
				}
				needle.post(endpoint.replace('https://','https://search.'), JSON.stringify(payload), { headers: searchHeaders }, (err, resp, body) => {
					body = Buffer.isBuffer(body) ? body.toString() : body
					if (body && body.nbHits) {
						let data
						try {
							data = JSON.parse(body.hits)
						} catch(e) {}
						if (data)
							resolve({ metas: data.map(toMeta) })
						else
							reject(defaults.name + ' - Could not parse search results for: ' + extra.search)
					} else
						reject(defaults.name + ' - No search results for: ' + extra.search)
				})
			} else {
				resolve({ metas: [] })
			}
		})
	})

	builder.defineMetaHandler(args => {
		return new Promise((resolve, reject) => {
			const id = args.id.replace(defaults.prefix, '')
			needle.get(endpoint + 'api/v5/hentai-videos/' + id + '?', { headers }, (err, resp, body) => {
				if (body && body.hentai_video)
					resolve({ meta: toMeta(body.hentai_video, body.hentai_tags) })
				else
					reject(defaults.name + ' - Could not get meta for: ' + args.id)
			})
		})
	})

	builder.defineStreamHandler(args => {
		return new Promise((resolve, reject) => {
			const id = args.id.replace(defaults.prefix, '')
			needle.get(endpoint + 'api/v3/videos_manifests/' + id + '?', { headers }, (err, resp, body) => {
				if ((((body || {}).videos_manifest || {}).servers || []).length) {
					const streamHeaders = {
						'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_13_6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/73.0.3683.103 Safari/537.36',
						'origin': headers.origin,
						'referer': headers.referer
					}
					const streams = []

					body.videos_manifest.servers.forEach(server => {
						if (((server || {}).streams || []).length)
							server.streams.forEach(stream => {
								if (stream.url)
									streams.push({
										title: server.name + '\n' + (stream.height ? (stream.height + 'p') : stream.title),
										url: proxy.addProxy(stream.url, { headers: streamHeaders })
									})
							})
					})

					resolve({ streams })
				} else
					reject(defaults.name + ' - Could not get streams for: ' + args.id)
			})
		})
	})

	const addonInterface = getInterface(builder)

	return getRouter(addonInterface)

}

module.exports = retrieveRouter()
