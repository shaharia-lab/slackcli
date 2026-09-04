/**
 * One definition of where this site lives.
 *
 * The site is published to GitHub Pages as a PROJECT site - no custom domain -
 * so every page sits under `/slackcli/`. That prefix is the difference from the
 * Agento site this one is a sibling of, and it is the reason no href in this
 * repository may be written as a bare `/docs/…`: Astro applies `base` to its
 * own routing and to Starlight's generated links, but NOT to hrefs you write by
 * hand or write into markdown. Everything hand-written goes through `url()`
 * below, so changing the prefix here moves the whole site.
 *
 * BASE carries a leading slash and NO trailing slash. It is concatenated
 * directly in a few places that do not go through `url()` - `${BASE}/docs/` in
 * scripts/sync-docs.mjs, and `href.slice(BASE.length)` /
 * `href.startsWith(BASE + '/')` in scripts/check-links.mjs - so a trailing
 * slash there would produce `//docs/`, an off-by-one slice, and a prefix test
 * that matches nothing, which breaks the docs links and silently stops the link
 * checker from checking. astro.config.mjs passes it to Astro as-is.
 *
 * If this project ever takes a custom domain, change SITE to it and BASE to the
 * EMPTY STRING (not '/'), and add the CNAME through
 * shaharia-lab/infrastructure rather than a file here.
 */
export const SITE = 'https://shaharia-lab.github.io';
export const BASE = '/slackcli';

export const REPO = 'https://github.com/shaharia-lab/slackcli';
export const REPO_BLOB = `${REPO}/blob/main`;

/** The name a share card and the structured data both call this site. */
export const SITE_NAME = 'SlackCLI';

/** Who publishes it. Used by the structured data on the landing page. */
export const ORG = { name: 'Shaharia Lab', url: 'https://shaharialab.com' };

/**
 * The share card. Drawn by design/og-image.html and rendered to public/og.png
 * by scripts/render-og.mjs; the dimensions are repeated in the meta tags,
 * because every consumer that pre-allocates space reads them rather than the
 * file. Keep the three in step.
 */
export const OG_IMAGE = { path: '/og.png', width: 1200, height: 630 };

/**
 * Google Tag Manager, or nothing at all.
 *
 * The container id is a build-time variable rather than a literal, and there is
 * deliberately NO baked-in default: an unset variable produces a site with no
 * third-party script on it whatsoever. That matters here because `npm run dev`,
 * a contributor's fork and every PR preview build would otherwise report into
 * the production container as if they were real traffic.
 *
 * Set it in the workflow from a repository variable:
 *
 *     env:
 *       PUBLIC_GTM_ID: ${{ vars.PUBLIC_GTM_ID }}
 *
 * The `PUBLIC_` prefix is Astro's: it marks a variable as safe to reach client
 * code, which a container id is - it is visible in the page source of every
 * site that uses one.
 */
export function gtmId() {
  const id = (process.env.PUBLIC_GTM_ID ?? '').trim();
  return /^GTM-[A-Z0-9]+$/.test(id) ? id : null;
}

/**
 * GTM's own loader, verbatim from the container's install instructions bar the
 * id. It is emitted `is:inline` on both halves of the site - Astro would
 * otherwise bundle it, and a bundled tag loader is fetched after the module
 * graph rather than during head parsing, which is the one thing this snippet
 * is shaped to avoid.
 *
 * The <noscript> iframe half of GTM's install is deliberately omitted. It
 * exists to fire tags for visitors without JavaScript, and every tag worth
 * having here needs JavaScript to do anything; including it would also mean
 * injecting markup into <body>, which Starlight's head-only extension point
 * cannot do - so the two halves of the site would end up with different
 * installs, which is worse than a missing fallback that fires nothing.
 */
export function gtmSnippet(id) {
  return `(function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({'gtm.start':new Date().getTime(),event:'gtm.js'});var f=d.getElementsByTagName(s)[0],j=d.createElement(s),dl=l!='dataLayer'?'&l='+l:'';j.async=true;j.src='https://www.googletagmanager.com/gtm.js?id='+i+dl;f.parentNode.insertBefore(j,f);})(window,document,'script','dataLayer','${id}');`;
}

/**
 * The consent key, shared by the two snippets below and by the footer's
 * "Cookie settings" link. One spelling, in one place.
 */
export const CONSENT_KEY = 'slackcli-consent';

/**
 * Google Consent Mode v2 defaults, emitted `is:inline` IMMEDIATELY BEFORE the
 * GTM loader on both halves of the site. The order is the whole point: a
 * default set after the container has loaded is a default the container never
 * saw, and the tags inside it will already have fired.
 *
 * Everything is denied except `security_storage`, and denied *globally* rather
 * than for the EEA alone. Consent Mode supports a `region` argument and this
 * deliberately does not use it: a site documenting a tool whose credentials
 * never leave the reader's machine should not be measuring the visitors whose
 * regulator happens not to require asking. It also removes a whole class of
 * bug, since the untested branch of a region rule is the one that runs for
 * almost everybody.
 *
 * `wait_for_update` holds tags for 500ms so a returning visitor's stored grant
 * lands before anything fires. The replay below is what usually beats it -
 * reading localStorage is synchronous, so the update is pushed in the same
 * task as the default and the wait never elapses. The 500ms is the fallback
 * for the first visit, where the answer comes from a click.
 *
 * v2 is the current version and there is no v4: `ad_user_data` and
 * `ad_personalization` are the two signals v2 added to v1, and both are here.
 */
export function consentDefaultSnippet() {
  return `window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments)}gtag('consent','default',{ad_storage:'denied',ad_user_data:'denied',ad_personalization:'denied',analytics_storage:'denied',functionality_storage:'denied',personalization_storage:'denied',security_storage:'granted',wait_for_update:500});try{var c=localStorage.getItem('${CONSENT_KEY}');if(c==='granted'||c==='denied'){var v=c==='granted'?'granted':'denied';gtag('consent','update',{ad_storage:v,ad_user_data:v,ad_personalization:v,analytics_storage:v,functionality_storage:v,personalization_storage:v})}}catch(e){}`;
}

/**
 * The banner itself: built in JavaScript rather than authored as markup, and
 * that is a constraint rather than a preference. Starlight builds its own
 * document and its only extension point is the head - which is why GTM's
 * <noscript> half is omitted (see gtmSnippet). A banner authored in
 * Page.astro would exist on the landing page and the blog and simply not on
 * the docs, which is the worst of the three outcomes. One head snippet reaches
 * both halves, and the banner needs JavaScript to do its job anyway.
 *
 * Four things here are requirements rather than choices:
 *
 * - **Accept and Reject are the same control.** Same size, same weight, same
 *   colour, adjacent. Regulators have repeatedly treated a prominent Accept
 *   beside a muted Reject as consent that was not freely given, and the design
 *   system has an accent that would make styling one of them "primary" the
 *   natural thing to do. Do not make Accept the primary button.
 * - **Refusing is one click**, same as accepting. There is no "manage
 *   preferences" step in between, because there is one purpose to consent to.
 * - **The choice is withdrawable.** `window.slackcliConsent.open()` reopens the
 *   banner and the footer link calls it, so changing your mind costs what
 *   giving consent cost.
 * - **It is inserted first in <body>**, not last. Fixed to the bottom visually,
 *   but early in the tab order - a keyboard visitor should not have to traverse
 *   the whole page to reach the thing blocking their consent decision.
 *
 * Dismissing without choosing is not offered: there is no X, and Escape does
 * not close it. An unanswered banner leaves the denied default in force, so
 * nothing is measured either way - but a dismiss control that silently means
 * "no" while looking like "later" is the pattern this is avoiding.
 */
export function consentBannerSnippet(privacyHref) {
  return `(function(){
var K='${CONSENT_KEY}',el=null;
function set(v){try{localStorage.setItem(K,v)}catch(e){}
  if(window.gtag){gtag('consent','update',{ad_storage:v,ad_user_data:v,ad_personalization:v,analytics_storage:v,functionality_storage:v,personalization_storage:v})}
  if(el){el.remove();el=null}}
function build(){
  if(el)return;
  el=document.createElement('div');
  el.className='cc';el.setAttribute('role','dialog');
  el.setAttribute('aria-labelledby','cc-t');el.tabIndex=-1;
  el.innerHTML='<div class="cc__in"><div class="cc__x"><span class="cc__l" id="cc-t">Cookies</span>'+
    '<p class="cc__p">This site uses Google Analytics to count visits, and nothing else. '+
    'The CLI itself talks to Slack and to nobody else - your tokens stay in ~/.config/slackcli. '+
    '<a class="cc__a" href="${privacyHref}">Where credentials live</a></p></div>'+
    '<div class="cc__b"><button type="button" class="cc__btn" data-v="denied">Reject</button>'+
    '<button type="button" class="cc__btn" data-v="granted">Accept</button></div></div>';
  el.addEventListener('click',function(e){var b=e.target.closest('[data-v]');if(b)set(b.getAttribute('data-v'))});
  document.body.insertBefore(el,document.body.firstChild);
}
window.slackcliConsent={open:function(){build();el.focus()}};
function start(){var c=null;try{c=localStorage.getItem(K)}catch(e){}
  if(c!=='granted'&&c!=='denied')build();
  document.addEventListener('click',function(e){
    var t=e.target.closest('[data-cookie-settings]');
    if(t){e.preventDefault();window.slackcliConsent.open()}});}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',start);else start();
})();`;
}

/** Join a site-absolute path onto the base. `url('/docs/')` → `/slackcli/docs/`. */
export function url(path = '/') {
  const p = path.startsWith('/') ? path : `/${path}`;
  return `${BASE}${p}`.replace(/\/{2,}/g, '/');
}

/**
 * The same, absolute. `og:image`, `twitter:image` and every `@id` in the
 * structured data must be fully qualified - a crawler and a share-card scraper
 * both resolve them out of context, where a site-relative path means nothing.
 */
export function abs(path = '/') {
  return `${SITE}${url(path)}`;
}
