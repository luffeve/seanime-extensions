/// <reference path="./manga-provider.d.ts" />
/// <reference path="./core.d.ts" />

/**
 * Seanime manga provider for MangaBall (https://mangaball.net)
 *
 * Originally a straight port of the official Mihon/Tachiyomi extension
 * (eu.kanade.tachiyomi.extension.all.mangaball), reverse-engineered from its
 * published Kotlin source at:
 * https://github.com/keiyoushi/extensions-source/tree/main/src/all/mangaball
 *
 * --- Why this looks more involved than a typical provider ---
 *
 * mangaball.net's /api/* endpoints sit behind real Cloudflare bot
 * protection. Confirmed via a working cURL repro posted in
 * https://github.com/keiyoushi/extensions-source/issues/13176, every POST
 * request needs a `cf_clearance` cookie - which is only issued after a
 * client actually solves Cloudflare's JS challenge - on top of a normal
 * PHP session cookie and CSRF token. A plain fetch() (even Seanime's own
 * TLS-impersonating client) cannot solve that challenge, which is exactly
 * why `search` / `findChapters` come back 403 while a plain GET (used by
 * `findChapterPages`) goes through fine. There's even an upstream issue
 * (https://github.com/keiyoushi/extensions-source/issues/16763) where the
 * *official* extension - running inside a full WebView on Android - failed
 * to bypass it too, so this is a genuinely hard site, not a bug in the
 * original port.
 *
 * The fix: drive a real (optionally headless) Chrome tab via Seanime's
 * `ChromeDP` API for any request that needs to look like a real browser.
 * The browser handles the Cloudflare challenge and attaches its own
 * cookies (including the HttpOnly cf_clearance one, which we have no way
 * to read out directly) automatically - we never need to see it.
 *
 * One wrinkle: Seanime's `browser.evaluate()` does NOT await Promises (its
 * Go implementation calls chromedp's Evaluate without `awaitPromise`), so
 * running an in-page `fetch()` would just hand us back an unresolved
 * Promise. To work around that we run a *synchronous* XMLHttpRequest
 * inside the page instead - it blocks the page's JS thread until the
 * response is in, so what evaluate() captures is a plain value.
 *
 * `findChapterPages` doesn't need any of this (a plain GET worked fine in
 * testing), so it still uses plain fetch(), with a browser-based fallback
 * in case that ever gets challenged too.
 *
 * IMPORTANT - if this still doesn't work for you:
 * If mangaball.net's Cloudflare rule for /api/* is configured to show an
 * interactive challenge (Turnstile/"Verify you are human" checkbox) rather
 * than a pure computational one, no amount of headless automation can
 * click through it - that's true for any tool, not just this one. Try
 * setting the `headless` config option to "false" (see manifest.json) to
 * pop a visible Chrome window and watch what actually happens on
 * navigation; that'll tell us in one look whether we're dealing with an
 * automatic challenge (should resolve on its own in a couple seconds) or
 * an interactive one (would need a human click, which we can't automate).
 * Either way, tell me what you see and we'll go from there.
 */

const API = "https://mangaball.net"

// User-configurable via manifest.json's userConfig.
const SHOW_NSFW_CONFIG: string = "{{show18plus}}"
const SHOW_NSFW = SHOW_NSFW_CONFIG !== "false"

const HEADLESS_CONFIG: string = "{{headless}}"
const HEADLESS = HEADLESS_CONFIG !== "false"

interface SmartSearchResponse {
    data: {
        manga: {
            title: string
            img: string
            url: string // relative, e.g. "/title-detail/slug-id/"
        }[]
    }
}

interface AdvancedSearchResponse {
    data: {
        url: string // absolute, e.g. "https://mangaball.net/title-detail/slug-id/"
        name: string
        cover: string
    }[]
    pagination: {
        current_page: number
        last_page: number
    }
}

interface ChapterListResponse {
    ALL_CHAPTERS: {
        number_float: number
        translations: {
            id: string
            name: string
            language: string
            date: string
            volume: number
            group: {
                _id: string
                name: string
            }
        }[]
    }[]
}

// ---------------------------------------------------------------------
// Module-level browser session cache.
//
// Seanime creates a brand new `Provider` instance for every single method
// call (search/findChapters/findChapterPages are NOT calls on the same
// object), so anything cached on `this` is useless across calls. The
// underlying JS VM *can* be reused across calls though, so module-level
// state like this actually has a chance to persist and save us from
// launching a fresh Chrome tab (and re-running Cloudflare's challenge) on
// every single request.
// ---------------------------------------------------------------------

let browserPromise: Promise<ChromeBrowser> | null = null

async function getBrowser(): Promise<ChromeBrowser> {
    if (!browserPromise) {
        browserPromise = (async () => {
            let browser: ChromeBrowser
            try {
                browser = await ChromeDP.newBrowser({ timeout: 60, headless: HEADLESS })
            } catch (e) {
                throw new Error(`Could not start Seanime's headless Chrome (ChromeDP). Is Chrome/Chromium available? Underlying error: ${e}`)
            }

            await browser.navigate(`${API}/`)

            try {
                await browser.waitReady('meta[name="csrf-token"]')
            } catch (e) {
                // Didn't show up in time - possibly still on a Cloudflare
                // interstitial. Give it a bit more time as a fallback
                // rather than failing outright.
                await browser.sleep(4000)
            }

            return browser
        })()

        browserPromise.catch(() => {
            browserPromise = null
        })
    }
    return browserPromise
}

async function resetBrowser(): Promise<void> {
    const current = browserPromise
    browserPromise = null
    if (current) {
        try {
            const browser = await current
            await browser.close()
        } catch (e) {
            // Browser may already be dead - nothing to do.
        }
    }
}

class Provider {

    getSettings(): Settings {
        return {
            supportsMultiLanguage: true,
            supportsMultiScanlator: true,
        }
    }

    // ---------------------------------------------------------------------
    // search
    // ---------------------------------------------------------------------

    async search(opts: QueryOptions): Promise<SearchResult[]> {
        const query = opts.query.trim()
        if (!query) {
            return []
        }

        try {
            try {
                const quick = await this.searchSmart(query)
                if (quick.length > 0) {
                    return quick
                }
            } catch (e) {
                console.error("MangaBall: smart-search failed", e)
            }

            try {
                return await this.searchAdvanced(query)
            } catch (e) {
                console.error("MangaBall: advanced search failed", e)
                return []
            }
        } finally {
            // Seanime's Go code discards the ChromeDP instance reference on
            // VM bind (goja.go:77), so Chrome processes are never cleaned up
            // by the framework on reload/shutdown. The only fix is to close
            // from JS ourselves before each public method returns.
            try { await resetBrowser() } catch (_) {}
        }
    }

    private async searchSmart(query: string): Promise<SearchResult[]> {
        const data = await this.apiPost<SmartSearchResponse>("/api/v1/smart-search/search/", [
            ["search_input", query],
        ])

        const results: SearchResult[] = []
        for (const m of data?.data?.manga ?? []) {
            const segments = this.pathSegments(m.url)
            if (segments.length < 2) {
                continue
            }
            results.push({
                id: segments[1],
                title: m.title,
                image: m.img,
                imageHeaders: { "Referer": `${API}/` },
            })
        }
        return results
    }

    private async searchAdvanced(query: string): Promise<SearchResult[]> {
        const data = await this.apiPost<AdvancedSearchResponse>("/api/v1/title/search-advanced/", [
            ["search_input", query],
            ["filters[sort]", "updated_chapters_desc"],
            ["filters[page]", "1"],
            ["filters[tag_included_mode]", "and"],
            ["filters[tag_excluded_mode]", "and"],
            ["filters[contentRating]", "any"],
            ["filters[demographic]", "any"],
            ["filters[person]", "any"],
            ["filters[publicationYear]", ""],
            ["filters[publicationStatus]", "any"],
            ["filters[originalLanguages]", "any"],
        ])

        const results: SearchResult[] = []
        for (const m of data?.data ?? []) {
            const segments = this.pathSegments(m.url)
            if (segments.length < 2) {
                continue
            }
            results.push({
                id: segments[1],
                title: m.name,
                image: m.cover,
                imageHeaders: { "Referer": `${API}/` },
            })
        }
        return results
    }

    // ---------------------------------------------------------------------
    // chapters
    // ---------------------------------------------------------------------

    async findChapters(mangaId: string): Promise<ChapterDetails[]> {
        try { return await this._findChapters(mangaId) }
        finally { try { await resetBrowser() } catch (_) {} }
    }

    private async _findChapters(mangaId: string): Promise<ChapterDetails[]> {
        try {
            const titleId = this.titleIdFromSlug(mangaId)

            const data = await this.apiPost<ChapterListResponse>(
                "/api/v1/chapter/chapter-listing-by-title-id/",
                [["title_id", titleId]],
            )

            const chapters: ChapterDetails[] = []

            for (const group of data?.ALL_CHAPTERS ?? []) {
                const numberStr = this.trimDecimal(group.number_float)

                for (const t of group.translations ?? []) {
                    let title = ""

                    const volumeStr = this.trimDecimal(t.volume)
                    if (t.volume > 0) {
                        title += `Vol. ${volumeStr} `
                    }

                    if (t.name && t.name.indexOf(numberStr) !== -1) {
                        title += t.name.trim()
                    } else {
                        title += `Ch. ${numberStr} ${t.name ? t.name.trim() : ""}`
                    }
                    title = title.trim()

                    chapters.push({
                        id: t.id,
                        url: `${API}/chapter-detail/${t.id}/`,
                        title: title,
                        chapter: numberStr,
                        index: 0, // assigned below, after sorting
                        language: t.language,
                        scanlator: this.formatScanlator(t.group),
                        updatedAt: this.toIso(t.date),
                    })
                }
            }

            chapters.sort((a, b) => parseFloat(a.chapter) - parseFloat(b.chapter))
            chapters.forEach((c, i) => {
                c.index = i
            })

            return chapters
        } catch (e) {
            console.error("MangaBall: findChapters failed", e)
            return []
        }
    }

    private formatScanlator(group: { _id: string, name: string }): string | undefined {
        if (!group) {
            return undefined
        }
        // group._id is normally a 24-char generated id for an active group on
        // the site. When it's NOT (e.g. it's a readable site name), it means
        // the chapter was scraped from elsewhere, so we surface it.
        if (this.groupIdRegex.test(group._id)) {
            return group.name
        }
        return `${group.name} (${group._id})`
    }

    private groupIdRegex = /^[a-z0-9]{24}$/

    // ---------------------------------------------------------------------
    // pages
    // ---------------------------------------------------------------------

    async findChapterPages(chapterId: string): Promise<ChapterPage[]> {
        try { return await this._findChapterPages(chapterId) }
        finally { try { await resetBrowser() } catch (_) {} }
    }

    private async _findChapterPages(chapterId: string): Promise<ChapterPage[]> {
        try {
            const url = `${API}/chapter-detail/${chapterId}/`
            let html: string | null = null

            try {
                const res = await fetch(url, { headers: { "Referer": `${API}/` } })
                if (res.ok) {
                    html = res.text()
                }
            } catch (e) {
                console.error("MangaBall: plain fetch for chapter page errored, will retry via browser", e)
            }

            if (!html) {
                // This path wasn't blocked in testing, but if it ever is,
                // fall back to the cookie-bearing browser session.
                const browser = await getBrowser()
                await browser.navigate(url)
                html = await browser.outerHTML("html")
            }

            const doc = new Doc(html)

            let scriptData = ""
            doc.find("script").each((_index, el) => {
                const content = el.html() ?? ""
                if (content.indexOf("chapterImages") !== -1) {
                    scriptData += content + ";"
                }
            })

            const match = scriptData.match(/const\s+chapterImages\s*=\s*JSON\.parse\(`([^`]+)`\)/)
            if (!match) {
                console.error("MangaBall: could not find chapterImages script for chapter", chapterId)
                return []
            }

            // The page's Blade template HTML-escapes the JSON before
            // embedding it in the backtick string (so quotes/ampersands in
            // image URLs come through as &quot;/&amp; etc instead of the
            // literal characters) - undo that before parsing as JSON.
            const decoded = this.decodeHtmlEntities(match[1])

            let images: string[]
            try {
                images = JSON.parse(decoded) as string[]
            } catch (e) {
                console.error(
                    "MangaBall: failed to JSON.parse chapterImages even after entity-decoding.",
                    "First 200 chars of decoded capture:", decoded.slice(0, 200),
                    "Error:", e,
                )
                return []
            }

            return images.map((src, index) => ({
                url: src,
                index,
                headers: { "Referer": `${API}/` },
            }))
        } catch (e) {
            console.error("MangaBall: findChapterPages failed", e)
            return []
        }
    }

    private decodeHtmlEntities(s: string): string {
        return s
            // Numeric character references, e.g. &#34; or &#x22; - this is
            // what actually showed up in testing (&#34; for the quote
            // character), not the named &quot; I originally assumed.
            .replace(/&#x([0-9a-fA-F]+);/g, (_m, hex) => String.fromCharCode(parseInt(hex, 16)))
            .replace(/&#(\d+);/g, (_m, dec) => String.fromCharCode(parseInt(dec, 10)))
            // Named entities, just in case the site uses these elsewhere.
            .replace(/&lt;/g, "<")
            .replace(/&gt;/g, ">")
            .replace(/&quot;/g, "\"")
            .replace(/&apos;/g, "'")
            .replace(/&amp;/g, "&")
    }

    // ---------------------------------------------------------------------
    // Cloudflare-aware POST helper (see file header for why this exists)
    // ---------------------------------------------------------------------

    private async apiPost<T>(path: string, params: [string, string][]): Promise<T> {
        const body = this.encodeForm(params)

        const run = async (): Promise<{ status: number, body: string }> => {
            const browser = await getBrowser()

            // Runs INSIDE the page. Uses a *synchronous* XHR (3rd arg to
            // open() is `false`) so evaluate() gets back a plain value
            // instead of an unresolved Promise - see file header.
            const jsCode = `
                (function() {
                    document.cookie = "show18PlusContent=${SHOW_NSFW}; path=/";
                    var meta = document.querySelector('meta[name="csrf-token"]');
                    var csrf = meta ? meta.getAttribute('content') : '';
                    var xhr = new XMLHttpRequest();
                    xhr.open('POST', ${JSON.stringify(path)}, false);
                    xhr.setRequestHeader('Content-Type', 'application/x-www-form-urlencoded; charset=UTF-8');
                    xhr.setRequestHeader('X-Requested-With', 'XMLHttpRequest');
                    xhr.setRequestHeader('X-CSRF-TOKEN', csrf);
                    xhr.send(${JSON.stringify(body)});
                    return { status: xhr.status, body: xhr.responseText };
                })()
            `

            return await browser.evaluate(jsCode) as { status: number, body: string }
        }

        let result = await run()

        if (result.status === 403 || result.status === 419) {
            // 419 is Laravel's own "CSRF token mismatch". Either way, the
            // session's gone stale - start a fresh tab/challenge and retry
            // once.
            await resetBrowser()
            result = await run()
        }

        if (result.status < 200 || result.status >= 300) {
            throw new Error(`MangaBall API request to ${path} failed: HTTP ${result.status}. Body: ${result.body.slice(0, 300)}`)
        }

        return JSON.parse(result.body) as T
    }

    // ---------------------------------------------------------------------
    // small utils
    // ---------------------------------------------------------------------

    private encodeForm(params: [string, string][]): string {
        return params
            .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
            .join("&")
    }

    /** Works for both relative ("/a/b/") and absolute ("https://host/a/b/") URLs. */
    private pathSegments(url: string): string[] {
        let path = url
        const schemeIdx = path.indexOf("://")
        if (schemeIdx !== -1) {
            const afterScheme = path.substring(schemeIdx + 3)
            const slashIdx = afterScheme.indexOf("/")
            path = slashIdx !== -1 ? afterScheme.substring(slashIdx) : "/"
        }
        return path.split("/").filter(s => s.length > 0)
    }

    /** "some-manga-title-685149d115e8b86aae68e4f3" -> "685149d115e8b86aae68e4f3" */
    private titleIdFromSlug(slug: string): string {
        const idx = slug.lastIndexOf("-")
        return idx !== -1 ? slug.substring(idx + 1) : slug
    }

    /** 5 -> "5", 5.5 -> "5.5", 5.0 -> "5" */
    private trimDecimal(n: number): string {
        const s = n.toString()
        return s.endsWith(".0") ? s.slice(0, -2) : s
    }

    /** "2024-01-02 03:04:05" -> "2024-01-02T03:04:05Z" */
    private toIso(dateStr?: string): string | undefined {
        if (!dateStr) {
            return undefined
        }
        const iso = dateStr.replace(" ", "T")
        return iso.length === 19 ? `${iso}Z` : iso
    }
}
