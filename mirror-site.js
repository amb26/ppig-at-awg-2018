/* eslint-env node */

"use strict";

/*
 * Mirrors https://ppigattheartworkersguild2018.wordpress.com/ into a fully self-contained local directory suitable
 * for static hosting (e.g. GitHub Pages at https://amb26.github.io/ppig-at-awg-2018/).
 *
 * As well as the site itself, this mirrors its uploads host, WordPress.com's shared static hosts (s0.wp.com etc.),
 * the Photon image CDN (i0.wp.com etc.), Gravatar avatars and Google Fonts. Every reference to any of these -
 * absolute, protocol-relative, JSON-escaped, root-relative or relative within CSS - is rewritten into a relative link,
 * so the result works under any base path. No dependencies - runs on node 16.6.2.
 *
 * The crawl runs in two passes: the first downloads everything reachable and records content types, the second
 * rewrites references (choosing file extensions from the content types) and writes the files.
 *
 * Usage: node mirror-site.js [outputDir]
 */

const https = require("https");
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const config = {
    siteHost: "ppigattheartworkersguild2018.wordpress.com",
    filesHost: "ppigattheartworkersguild2018.files.wordpress.com",
    // Local directory for the site's uploads
    filesPrefix: "_files",
    // Local directory under which other hosts are stored, each in a subdirectory named after the host
    externalPrefix: "_ext",
    outDir: path.resolve(process.argv[2] ?? "ppig-at-awg-2018"),
    delayMs: 150,
    maxRedirects: 5,
    timeoutMs: 30000,
    // Header sets tried in turn when a request is refused with 403 or 429. WordPress.com's edge rejects requests
    // whose headers look inconsistent (e.g. a browser User-Agent without the headers a browser sends), so the first
    // profile is a complete browser set - which also makes Google Fonts serve woff2 - and the second is an honest
    // crawler identity. Set MIRROR_UA in the environment to try a User-Agent of your own first.
    headerProfiles: [
        process.env.MIRROR_UA ? {"User-Agent": process.env.MIRROR_UA, "Accept": "*/*"} : null,
        {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
            "Accept-Language": "en-GB,en;q=0.9",
            "Sec-Ch-Ua": "\"Chromium\";v=\"124\", \"Google Chrome\";v=\"124\", \"Not-A.Brand\";v=\"99\"",
            "Sec-Ch-Ua-Mobile": "?0",
            "Sec-Ch-Ua-Platform": "\"Windows\"",
            "Sec-Fetch-Dest": "document",
            "Sec-Fetch-Mode": "navigate",
            "Sec-Fetch-Site": "none",
            "Sec-Fetch-User": "?1",
            "Upgrade-Insecure-Requests": "1"
        },
        {
            "User-Agent": "static-mirror/1.0 (archiving a site for static hosting; node.js)",
            "Accept": "*/*"
        }
    ].filter(function (profile) {
        return profile !== null;
    }),
    // Further hosts whose resources are mirrored. Tracking and widget hosts (stats.wp.com, pixel.wp.com,
    // widgets.wp.com, public-api.wordpress.com) are deliberately absent
    assetHostPatterns: [
        /^[sic]\d\.wp\.com$/,
        /\.files\.wordpress\.com$/,
        /^fonts\.googleapis\.com$/,
        /^fonts\.gstatic\.com$/,
        /^(\d|secure)\.gravatar\.com$/
    ],
    // Site paths which are dynamic or useless in a static copy - links to these are left absolute
    excludePatterns: [
        /^\/wp-admin/,
        /^\/wp-login\.php/,
        /^\/wp-json/,
        /^\/xmlrpc\.php/,
        /\/feed\/?$/,
        /\/embed\/?$/,
        /\/amp\/?$/
    ]
};

// Absolute, protocol-relative and JSON-escaped (https:\/\/host\/path) references to candidate hosts.
// Stops at quotes, whitespace, brackets and HTML-encoded quotes.
const absoluteUrlRegex = /(?:https?:)?(?:\/\/|\\\/\\\/)([a-z0-9.-]+\.(?:wordpress\.com|wp\.com|gravatar\.com|googleapis\.com|gstatic\.com))((?:(?!&quot;|&#0?39;)[^\s"'<>()[\]{}`])*)/gi;
const cssUrlRegex = /url\(\s*(['"]?)([^'")\s]+)\1\s*\)/g;
const cssImportRegex = /@import\s+(['"])([^'"]+)\1/g;
// Attributes which are meaningless once all resources are same-origin, and harmful in the mirror: "crossorigin" makes
// browsers refuse resources from file:// URLs, and "integrity" hashes no longer match content whose links were rewritten
const htmlStripAttributeRegex = /\s(?:crossorigin|integrity)(?:=(?:"[^"]*"|'[^']*'|[^\s>]+))?(?=[\s/>])/gi;
const htmlTagRegex = /<(?:link|script|img|source|video|audio)\b[^>]*>/gi;
const htmlRootRelativeRegex = /\b(href|src|poster|data-src|data-orig-file|data-medium-file|data-large-file)=(["'])(\/(?!\/)[^"']*)\2/g;

const typeExtensions = {
    "text/html": ".html",
    "application/xhtml+xml": ".html",
    "text/css": ".css",
    "text/javascript": ".js",
    "application/javascript": ".js",
    "application/x-javascript": ".js",
    "application/json": ".json",
    "text/xml": ".xml",
    "application/xml": ".xml",
    "text/plain": ".txt",
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "image/svg+xml": ".svg",
    "image/x-icon": ".ico",
    "image/vnd.microsoft.icon": ".ico",
    "font/woff2": ".woff2",
    "font/woff": ".woff",
    "font/ttf": ".ttf",
    "font/otf": ".otf",
    "application/font-woff": ".woff",
    "application/font-woff2": ".woff2",
    "application/x-font-ttf": ".ttf",
    "application/vnd.ms-fontobject": ".eot",
    "application/pdf": ".pdf"
};

/**
 * Pauses for the given duration.
 * @param {Number} ms - Number of milliseconds to wait.
 * @return {Promise} A promise which resolves after the delay.
 */
const delay = function (ms) {
    return new Promise(function (resolve) {
        setTimeout(resolve, ms);
    });
};

/**
 * Safely decodes a URI component, falling back to the raw value if it is malformed.
 * @param {String} text - The possibly percent-encoded text.
 * @return {String} The decoded text.
 */
const safeDecode = function (text) {
    let decoded;
    try {
        decoded = decodeURIComponent(text);
    } catch (e) {
        decoded = text;
    }
    return decoded;
};

/**
 * Parses a URL, returning null rather than throwing if it is malformed.
 * @param {String} url - The URL, absolute or relative.
 * @param {String} [base] - The base URL against which a relative URL is resolved.
 * @return {URL|null} The parsed URL, or null if it could not be parsed.
 */
const parseUrl = function (url, base) {
    let parsed;
    try {
        parsed = new URL(url, base);
    } catch (e) {
        parsed = null;
    }
    return parsed;
};

/**
 * Extracts the bare MIME type from a Content-Type header.
 * @param {String} contentType - The value of a Content-Type header, possibly with parameters.
 * @return {String} The lower-cased MIME type without parameters.
 */
const mimeOf = function (contentType) {
    return (contentType ?? "").split(";")[0].trim().toLowerCase();
};

/**
 * Determines whether a MIME type denotes text which may contain URLs to rewrite.
 * @param {String} mime - A bare MIME type.
 * @return {Boolean} `true` if the content is textual.
 */
const isTextType = function (mime) {
    return /^(text\/|application\/(javascript|x-javascript|json|xml|rss\+xml|atom\+xml|xhtml\+xml)$|image\/svg\+xml$)/.test(mime);
};

/**
 * Determines whether a host is one whose query string selects different content, and so must be kept.
 * @param {String} host - The host name.
 * @return {Boolean} `true` if the query string is significant for this host.
 */
const isQuerySignificant = function (host) {
    return host !== config.siteHost && host !== config.filesHost;
};

/**
 * Determines whether a URL should be downloaded and have references to it rewritten as relative.
 * @param {URL} url - The URL to test.
 * @return {Boolean} `true` if the URL belongs to the mirrored content.
 */
const shouldMirror = function (url) {
    let togo = false;
    if (url.protocol === "https:" || url.protocol === "http:") {
        if (url.hostname === config.siteHost) {
            togo = !config.excludePatterns.some(function (pattern) {
                return pattern.test(url.pathname);
            });
        } else if (url.hostname === config.filesHost) {
            togo = true;
        } else {
            // Bare host references (e.g. dns-prefetch links) are not resources
            togo = url.pathname !== "/" && config.assetHostPatterns.some(function (pattern) {
                return pattern.test(url.hostname);
            });
        }
    }
    return togo;
};

/**
 * Reduces a URL to the key under which its resource is fetched and stored: https, no fragment, and no query string
 * for hosts where the query is insignificant.
 * @param {URL} url - The URL to canonicalize.
 * @return {String} The canonical URL String.
 */
const canonicalize = function (url) {
    const copy = new URL(url.href);
    copy.hash = "";
    copy.protocol = "https:";
    if (!isQuerySignificant(copy.hostname)) {
        copy.search = "";
    }
    return copy.href;
};

/**
 * Computes the local directory prefix for a host.
 * @param {String} host - The host name.
 * @return {String} The posix directory prefix, with trailing slash, or the empty String for the site itself.
 */
const prefixFor = function (host) {
    let prefix;
    if (host === config.siteHost) {
        prefix = "";
    } else if (host === config.filesHost) {
        prefix = config.filesPrefix + "/";
    } else {
        prefix = config.externalPrefix + "/" + host + "/";
    }
    return prefix;
};

/**
 * Replaces characters which are unsafe in file names on common file systems.
 * @param {String} filePath - A posix path.
 * @return {String} The sanitized path.
 */
const sanitizePath = function (filePath) {
    return filePath.split("/").map(function (segment) {
        return segment.replace(/[<>:"|?*\\]/g, "_");
    }).join("/");
};

/**
 * Computes where a fetched resource is stored in the mirror.
 * @param {String} key - The canonical URL of the resource.
 * @param {String} mime - The resource's bare MIME type.
 * @return {Object} An object with members `file` - the posix path of the stored file relative to the output
 * directory, and `link` - the posix path that links should target (a directory with trailing slash for pages).
 */
const localPathFor = function (key, mime) {
    const url = new URL(key);
    const pathname = safeDecode(url.pathname);
    const prefix = prefixFor(url.hostname);
    let file, link;
    if (url.hostname === config.siteHost && (pathname.endsWith("/") || path.posix.extname(pathname) === "")) {
        const dir = pathname.endsWith("/") ? pathname : pathname + "/";
        file = dir + "index.html";
        link = dir;
    } else {
        let base = pathname.endsWith("/") ? pathname + "index" : pathname;
        let ext = path.posix.extname(base);
        const typeExt = typeExtensions[mime] ?? "";
        if (url.search !== "") {
            const hash = crypto.createHash("sha1").update(url.search).digest("hex").slice(0, 10);
            base = (ext === "" ? base : base.slice(0, -ext.length)) + "__" + hash;
        } else {
            ext = "";
        }
        // Ensure the served MIME type matches by giving the file an extension consistent with its content
        const pathExt = path.posix.extname(pathname).toLowerCase();
        if (typeExt !== "" && pathExt !== typeExt && !(pathExt === ".jpeg" && typeExt === ".jpg")) {
            ext = (url.search !== "" ? "" : ext) + typeExt;
        } else if (url.search !== "") {
            ext = pathExt;
        }
        file = base + ext;
        link = file;
    }
    return {
        file: sanitizePath(prefix + file.replace(/^\/+/, "")),
        link: sanitizePath(prefix + link.replace(/^\/+/, ""))
    };
};

/**
 * Computes a relative link from the file currently being written to a mirrored target.
 * @param {String} currentFile - Posix path, relative to the output directory, of the file containing the link.
 * @param {String} targetLink - Posix path, relative to the output directory, of the link target.
 * @return {String} A URL-encoded relative link.
 */
const relativeLink = function (currentFile, targetLink) {
    const fromDir = path.posix.dirname(currentFile);
    const isDirectory = targetLink === "" || targetLink.endsWith("/");
    let rel = path.posix.relative(fromDir, targetLink.replace(/\/$/, "") || ".");
    if (isDirectory) {
        rel = (rel === "" ? "." : rel) + "/";
    } else if (rel === "") {
        rel = path.posix.basename(targetLink);
    }
    return encodeURI(rel);
};

/**
 * Builds a regular expression matching a start tag whose class attribute contains the given class.
 * @param {String} className - The class name to match.
 * @return {RegExp} A regular expression to be tested against a start tag.
 */
const classMatcher = function (className) {
    return new RegExp("\\bclass=([\"'])(?:[^\"']*\\s)?" + className + "(?:\\s[^\"']*)?\\1", "i");
};

/**
 * Builds a regular expression matching a start tag with the given id.
 * @param {String} id - The id to match.
 * @return {RegExp} A regular expression to be tested against a start tag.
 */
const idMatcher = function (id) {
    return new RegExp("\\bid=([\"'])" + id + "\\1", "i");
};

// Elements removed from mirrored pages since they depend on WordPress.com and cannot work statically. Each rule
// names a tag, a test applied to its start tag and optionally a test applied to its text content.
const removalRules = [
    // "Share this:" buttons and "Like" widget, including the jp-post-flair wrapper holding both
    {tag: "div", start: classMatcher("sharedaddy")},
    {tag: "div", start: idMatcher("jp-post-flair")},
    // Comment form, and "Reply" links on existing comments
    {tag: "div", start: idMatcher("respond")},
    {tag: "div", start: classMatcher("reply"), text: /\bReply\b/i},
    // "Leave a comment" links in post metadata - "N Comments" links to existing comments are kept
    {tag: "span", start: classMatcher("comments-link"), text: /Leave a comment/i},
    {tag: "div", start: classMatcher("comments-link"), text: /Leave a comment/i},
    {tag: "a", start: /\bhref=(["'])[^"']*#respond\1/i, text: /Leave a comment/i},
    // Floating Subscribe / Follow bar with its "Loading Comments..." overlay
    {tag: "div", start: idMatcher("actionbar")}
];

/**
 * Finds the end of the element whose start tag ends at the given position, allowing for nested elements of the same tag.
 * @param {String} html - The HTML text.
 * @param {String} tag - The tag name of the element.
 * @param {Number} from - The index just after the element's start tag.
 * @return {Object|null} An object with members `innerEnd` - the index of the closing tag, and `end` - the index just
 * after it, or null if the element is not closed.
 */
const findElementEnd = function (html, tag, from) {
    const tagRegex = new RegExp("<(/?)" + tag + "\\b[^>]*>", "gi");
    tagRegex.lastIndex = from;
    let depth = 1;
    let found = null;
    let match = tagRegex.exec(html);
    while (match !== null && found === null) {
        if (match[1] === "/") {
            depth--;
        } else if (!match[0].endsWith("/>")) {
            depth++;
        }
        if (depth === 0) {
            found = {innerEnd: match.index, end: tagRegex.lastIndex};
        } else {
            match = tagRegex.exec(html);
        }
    }
    return found;
};

/**
 * Removes every element matching a removal rule from HTML text.
 * @param {String} html - The HTML text.
 * @param {Object} rule - A rule from `removalRules`, with members `tag`, `start` and optionally `text`.
 * @return {String} The HTML with matching elements removed.
 */
const removeElements = function (html, rule) {
    const startRegex = new RegExp("<" + rule.tag + "\\b[^>]*>", "gi");
    let output = "";
    let pos = 0;
    let match = startRegex.exec(html);
    while (match !== null) {
        if (rule.start.test(match[0])) {
            const end = findElementEnd(html, rule.tag, startRegex.lastIndex);
            if (end) {
                const text = html.slice(startRegex.lastIndex, end.innerEnd).replace(/<[^>]*>/g, " ");
                if (!rule.text || rule.text.test(text)) {
                    output += html.slice(pos, match.index);
                    pos = end.end;
                    startRegex.lastIndex = end.end;
                }
            }
        }
        match = startRegex.exec(html);
    }
    return output + html.slice(pos);
};

/**
 * Removes all elements which cannot function in the static mirror, as listed in `removalRules`.
 * @param {String} html - The HTML text.
 * @return {String} The HTML with these elements removed.
 */
const removeDynamicElements = function (html) {
    return removalRules.reduce(removeElements, html);
};

/**
 * Finds every mirrorable reference in a text resource and optionally replaces it. Used both for discovery
 * (where `mapRef` records the reference and returns null) and for rewriting.
 * @param {String} text - The resource text.
 * @param {String} baseUrl - The URL from which the resource was fetched, for resolving relative references.
 * @param {String} mime - The resource's bare MIME type.
 * @param {Function} mapRef - Called with the canonical URL String and fragment String of each mirrorable reference;
 * returns the String to substitute, or null to leave the reference unchanged.
 * @return {String} The possibly rewritten text.
 */
const transformText = function (text, baseUrl, mime, mapRef) {
    const mapUrl = function (url) {
        let togo = null;
        if (url && shouldMirror(url)) {
            togo = mapRef(canonicalize(url), url.hash);
        }
        return togo;
    };
    const isRelativeRef = function (ref) {
        return ref !== "" && !/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(ref);
    };
    let result = text;
    if (mime === "text/css") {
        result = result.replace(cssUrlRegex, function (match, quote, ref) {
            let replacement = match;
            if (isRelativeRef(ref)) {
                const mapped = mapUrl(parseUrl(ref, baseUrl));
                if (mapped !== null) {
                    replacement = "url(" + quote + mapped + quote + ")";
                }
            }
            return replacement;
        });
        result = result.replace(cssImportRegex, function (match, quote, ref) {
            let replacement = match;
            if (isRelativeRef(ref)) {
                const mapped = mapUrl(parseUrl(ref, baseUrl));
                if (mapped !== null) {
                    replacement = "@import " + quote + mapped + quote;
                }
            }
            return replacement;
        });
    } else if (mime === "text/html" || mime === "application/xhtml+xml") {
        result = removeDynamicElements(result);
        result = result.replace(htmlTagRegex, function (tag) {
            return tag.replace(htmlStripAttributeRegex, "");
        });
        result = result.replace(htmlRootRelativeRegex, function (match, attr, quote, ref) {
            const mapped = mapUrl(parseUrl(ref.replace(/&amp;/g, "&"), baseUrl));
            let replacement = match;
            if (mapped !== null) {
                replacement = attr + "=" + quote + mapped + quote;
            }
            return replacement;
        });
    }
    result = result.replace(absoluteUrlRegex, function (match, host, rawRest) {
        let rest = rawRest;
        let suffix = "";
        let replacement = match;
        // Trailing backslashes (escaped quotes) and sentence punctuation are not part of the URL
        const trailing = /[\\.,;:!?]+$/.exec(rest);
        if (trailing) {
            suffix = trailing[0];
            rest = rest.slice(0, -suffix.length);
        }
        const plainRest = rest.replace(/\\\//g, "/").replace(/&amp;/g, "&");
        // Anything else means the "host" was only a prefix of some longer host name
        if (plainRest === "" || /^[/?#]/.test(plainRest)) {
            const mapped = mapUrl(parseUrl("https://" + host.toLowerCase() + plainRest));
            if (mapped !== null) {
                const escaped = match.includes("\\/");
                replacement = (escaped ? mapped.replace(/\//g, "\\/") : mapped) + suffix;
            }
        }
        return replacement;
    });
    return result;
};

/**
 * Fetches a URL with a particular set of request headers, following redirects.
 * @param {String} url - The absolute URL to fetch.
 * @param {Number} redirectsLeft - The number of further redirects which may be followed.
 * @param {Object} profile - The request headers to send.
 * @return {Promise<Object>} Resolves to an object with members `status` - the HTTP status Number,
 * `contentType` - the Content-Type header String, `body` - the response Buffer and `finalUrl` - the URL String finally fetched.
 */
const fetchWithProfile = function (url, redirectsLeft, profile) {
    return new Promise(function (resolve, reject) {
        const client = url.startsWith("https:") ? https : http;
        const req = client.get(url, {
            headers: Object.assign({}, profile, {"Accept-Encoding": "identity"}),
            timeout: config.timeoutMs
        }, function (res) {
            const status = res.statusCode;
            if (status >= 300 && status < 400 && res.headers.location && redirectsLeft > 0) {
                res.resume();
                const next = new URL(res.headers.location, url).href;
                fetchWithProfile(next, redirectsLeft - 1, profile).then(resolve, reject);
            } else {
                const chunks = [];
                res.on("data", function (chunk) {
                    chunks.push(chunk);
                });
                res.on("end", function () {
                    resolve({
                        status: status,
                        contentType: res.headers["content-type"] ?? "",
                        body: Buffer.concat(chunks),
                        finalUrl: url
                    });
                });
                res.on("error", reject);
            }
        });
        req.on("timeout", function () {
            req.destroy(new Error("Timed out fetching " + url));
        });
        req.on("error", reject);
    });
};

// Index into config.headerProfiles of the profile which last succeeded, tried first for subsequent requests
let preferredProfile = 0;

/**
 * Fetches a URL, following redirects, falling back through the configured header profiles if refused.
 * @param {String} url - The absolute URL to fetch.
 * @param {Number} redirectsLeft - The number of further redirects which may be followed.
 * @return {Promise<Object>} Resolves to the response Object of the first profile not refused, or of the last
 * profile tried - see `fetchWithProfile` for its members.
 */
const fetchUrl = async function (url, redirectsLeft) {
    const order = config.headerProfiles.map(function (profile, index) {
        return index;
    });
    order.splice(order.indexOf(preferredProfile), 1);
    order.unshift(preferredProfile);
    let response = null;
    let i = 0;
    while (i < order.length && (response === null || response.status === 403 || response.status === 429)) {
        if (response !== null) {
            const snippet = response.body.toString("utf8").replace(/\s+/g, " ").slice(0, 200);
            console.warn("  HTTP " + response.status + " with header profile " + order[i - 1] + ": " + snippet);
            await delay(1000);
        }
        response = await fetchWithProfile(url, redirectsLeft, config.headerProfiles[order[i]]);
        if (response.status !== 403 && response.status !== 429) {
            preferredProfile = order[i];
        }
        i++;
    }
    return response;
};

/**
 * Writes a file into the output directory, creating parent directories as required.
 * @param {String} relFile - Posix path of the file relative to the output directory.
 * @param {String|Buffer} content - The content to write.
 */
const writeOutput = function (relFile, content) {
    const target = path.join(config.outDir, ...relFile.split("/"));
    fs.mkdirSync(path.dirname(target), {recursive: true});
    fs.writeFileSync(target, content);
};

/**
 * First pass: crawls breadth-first from the site root, downloading every reachable mirrorable resource.
 * @return {Promise<Object>} Resolves to an object with members `resources` - a Map from canonical URL String to
 * an Object holding `mime` and `body`, and `failed` - String[] of URLs which could not be retrieved.
 */
const download = async function () {
    const rootKey = canonicalize(new URL("https://" + config.siteHost + "/"));
    const queue = [rootKey];
    const seen = new Set([rootKey]);
    const resources = new Map();
    const failed = [];

    const enqueue = function (key) {
        if (!seen.has(key)) {
            seen.add(key);
            queue.push(key);
        }
        return null;
    };

    while (queue.length > 0) {
        const key = queue.shift();
        try {
            const response = await fetchUrl(key, config.maxRedirects);
            if (response.status === 200) {
                const mime = mimeOf(response.contentType);
                resources.set(key, {mime: mime, body: response.body});
                if (isTextType(mime)) {
                    transformText(response.body.toString("utf8"), key, mime, enqueue);
                }
                console.log("Fetched " + key + " (" + resources.size + " done, " + queue.length + " queued)");
            } else {
                failed.push(key);
                console.warn("HTTP " + response.status + " for " + key);
            }
        } catch (e) {
            failed.push(key);
            console.warn("Error fetching " + key + ": " + e.message);
        }
        await delay(config.delayMs);
    }
    return {resources, failed};
};

/**
 * Second pass: rewrites references within every downloaded text resource and writes all resources to disk.
 * @param {Map} resources - Map from canonical URL String to an Object holding `mime` and `body`.
 * @return {Number} The number of files written.
 */
const writeMirror = function (resources) {
    const locations = new Map();
    resources.forEach(function (resource, key) {
        locations.set(key, localPathFor(key, resource.mime));
    });
    const written = new Set();
    resources.forEach(function (resource, key) {
        const file = locations.get(key).file;
        // e.g. /about and /about/ both map to about/index.html - keep the first
        if (!written.has(file)) {
            written.add(file);
            let content = resource.body;
            if (isTextType(resource.mime)) {
                content = transformText(resource.body.toString("utf8"), key, resource.mime, function (refKey, hash) {
                    const target = locations.get(refKey);
                    // References to resources which failed to download are left absolute
                    return target ? relativeLink(file, target.link) + hash : null;
                });
            }
            writeOutput(file, content);
        }
    });
    return written.size;
};

/**
 * Entry point - runs both passes and writes the supporting files for GitHub Pages.
 * @return {Promise} Resolves when mirroring is complete.
 */
const main = async function () {
    console.log("Mirroring into " + config.outDir);
    const {resources, failed} = await download();
    fs.mkdirSync(config.outDir, {recursive: true});
    // Prevent GitHub Pages' Jekyll from hiding the underscore-prefixed directories
    writeOutput(".nojekyll", "");
    const count = writeMirror(resources);
    console.log("\nDone: " + count + " files written, " + failed.length + " failures.");
    if (failed.length > 0) {
        console.log("Failed URLs (references to these remain absolute):\n  " + failed.join("\n  "));
    }
};

main().catch(function (e) {
    console.error(e);
    process.exitCode = 1;
});
