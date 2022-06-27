import indexHtml from './public/index.html';

const TRANSFORMS = [
    {
        'short': 'rpf',
        'long': 'Remove Preload Fonts',
        'id': 0
    },
    {
        'short': 'rps',
        'long': 'Remove Preload Scripts',
        'id': 1
    },
    {
        'short': 'rpi',
        'long': 'Remove Preload Images',
        'id': 2
    },
    {
        'short': 'rpc',
        'long': 'Remove Preload Styles',
        'id': 3
    },
    {
        'short': 'ds',
        'long': 'Defer Scripts',
        'id': 4
    },
    {
        'short': 'ai',
        'long': 'Add <code>decoding="async"</code> to <code>&lt;img&gt;</code> elements',
        'id': 5
    },
    {
        'short': 'li',
        'long': 'Add <code>loading="lazy"</code> to <code>&lt;img&gt;</code> elements',
        'id': 6
    },
    {
        'short': 'si',
        'long': 'Swap <code>&lt;img data-src&gt;</code> for <code>&lt;img src&gt;</code>',
        'id': 7
    },
    {
        'short': 'dc',
        'long': 'Defer external CSS',
        'id': 8
    },
    {
        'short': 'ric',
        'long': 'Remove inline CSS',
        'id': 9
    },
    {
        'short': 'sc',
        'long': 'Un-async external CSS',
        'id': 10
    },
    {
        'short': 'oi',
        'long': 'Optimise Images (experimental)',
        'id': 11
    }, {
        'short': 'rgf',
        'long': 'Remove Google Fonts CSS',
        'id': 12
    }
];

const ELEMENTS = [
    '_th','_ht','_hb','_bt','_bb','_oi','_h','_fpl','_fph'
];

async function handleRequest(request) {
    const url = new URL(request.url);

    /* show the main page */
    if (url.host == "perfproxy.com") {
      return new Response(indexHtml,{headers:{'Content-Type': 'text/html'}});
    }
    let host = request.headers.get('x-host') || request.headers.get('host');
    let subhost = url.host.replace('.perfproxy.com','');
    if (subhost.includes('_')) {
      host = subhost.replaceAll('_','.');
    }
    const accept = request.headers.get('accept');

    /* replace proxy hostname with target host */
    url.hostname = host;

    /* deny common requests */
    if (url.pathname === '/robots.txt') {
      return new Response('User-agent: *\nDisallow: /');
    }
    if (url.pathname === '/sitemap.xml') {
      return new Response('',{'status':404,'statusText':'There is nothing here.'});
    }

    /* html requests */
    if (accept && accept.includes('text/html')) {
        console.log("HTML");
        let transformations = getTransformations(url);
        let newUrl = new URL(url);

        /* tidy up the URL to origin */
        newUrl.searchParams.delete('_pp');
        ELEMENTS.forEach(el => {
            newUrl.searchParams.delete(el);
        });
        let newRequest = new Request(newUrl.href,request);

        /* override host to prevent redirects */
        newRequest.headers.set('host',host);

        /* fetch from origin */
        let res = await fetch(newUrl.toString(), newRequest);

        /* follow redirects */
        let redirects = 0;
        let isRedirect = res.headers.has('location') && res.status >= 300 && res.status < 400;
        while (isRedirect && redirects < 3) {
            let target = res.headers.get('location');
            console.log(`Redirected to ${target}`);
            res = await fetch(target, newRequest);
            redirects++;
            isRedirect = res.headers.has('location') && res.status >= 300 && res.status < 400;
        }
        let response = new Response(res.body, res);

        /* set some debug headers */
        response.headers.set("x-proxied","true");
        if (isRedirect) {
            response.headers.set("x-proxy-redirect-loop",isRedirect);
        }
        if (redirects > 0) {
            response.headers.set("x-proxy-redirects",redirects);
        }

        /* set headers */
        if (transformations.hasOwnProperty('_h')) {
            transformations._h.forEach(h => {
                [key,val] = h.split(":");
                response.headers.set(key.trim(),val.trim());
            });
        }

        /* for image optimsation we need to set client hint response headers and set a cookie for state */
        if (transformations.hasOwnProperty('oi')) {
            response.headers.set("accept-ch","DPR,Width");
            response.headers.append("set-cookie","_oi=true");
        }

        /* remove CSP */
        response.headers.delete('content-security-policy');
        response.headers.delete('content-security-policy-report-only');

        /* disable search engine indexing */
        response.headers.append('X-Robots-Tag','noindex');

        let rewritten = rewrite(response,transformations,newUrl);
        return rewritten;
    } else if (
        /* image requests */
        accept && accept.includes('image/*') && !(/\.svg/.test(url.toString())) &&
        (url.searchParams.has("_oi") || (request.headers.has('cookie') && request.headers.get('cookie').includes('_oi=true')))) {
        let options = {
            cf: {
                image: {
                    quality: 60,
                    dpr: 1,
                    width: 640
                }
            }
        };
        if (/image\/avif/.test(accept)) {
            options.cf.image.format = 'avif';
        } else if (/image\/webp/.test(accept)) {
            options.cf.image.format = 'webp';
        }
        if (request.headers.has('DPR')) {
            options.cf.image.dpr = Math.min(2,Math.floor(parseFloat(request.headers.get('DPR'))));
        }
        if (request.headers.has('Width')) {
            options.cf.image.width = Math.floor(parseFloat(request.headers.get('Width')));
        }
        console.log(`Image request for ${url.toString()}`);
        console.log(options);

        const imageRequest = new Request(url.toString(), request);
        let imgResponse = await fetch(imageRequest, options);
        let newImgResponse = new Response(imgResponse.body,imgResponse);
        newImgResponse.headers.append('x-proxied','true');
        newImgResponse.headers.append('X-Robots-Tag','noindex');
        return newImgResponse;
    } else {
        /* transparent pass-through for non-matched requests */
        console.log("PASS-THRU");
        let response = await fetch(url.toString(), request);
        let newResponse = new Response(response.body,response);
        newResponse.headers.append('X-Robots-Tag','noindex');
        return newResponse;
    }
}

function getTransformations(url) {
    console.log(`Getting transformations for url: '${url}'`);
    let data = {};
    let a = url.searchParams.get('_pp');
    if (a) {
        if (a.indexOf('-')>-1) {
            let parts = a.split('-');
            a = parseInt(parts[0],16).toString(2).padStart(parts[1]);
        }
        try {
            for (let t in TRANSFORMS) {
                data[TRANSFORMS[t].short] = (a[t] == '1');
            }
        } catch (e) {
            console.error(`Failed to decode string: ${a}`);
            return data;
        }
    }
    ELEMENTS.forEach(el => {
        if (url.searchParams.has(el)) {
            data[el] = url.searchParams.getAll(el).map(e => decodeURIComponent(e));
        }
    });
    console.log(data);
    return data;
}

function rewrite(response,transformations,url) {
    /* rewrite HTML */
    /* TODO: rewrites for
     * External CSS
     * inline CSS
     * fonts
     */
    let hr = new HTMLRewriter()
    .on('link[rel="preload"]', {
        element: el => {
            if (
                (transformations.rpf && el.getAttribute('as') == 'font') ||
                (transformations.rps && el.getAttribute('as') == 'script') ||
                (transformations.rpi && el.getAttribute('as') == 'image') ||
                (transformations.rpc && el.getAttribute('as') == 'style')
                ) {
                el.remove();
            }
        }
    })
    .on('script[src]', {
        element: el => {
            if (transformations.ds) {
                el.setAttribute("defer","defer");
                el.removeAttribute("async");
            }
        }
    })
    .on('img', {
        element: el => {
            if (transformations.ai) {
                el.setAttribute("decoding","async");
            }
            if (transformations.li) {
                el.setAttribute("loading","lazy");
            }
            if (transformations.si && el.hasAttribute('data-src') && !el.hasAttribute('src')) {
                el.setAttribute("src",el.getAttribute("data-src"));
                el.removeAttribute("data-src");
                if (el.hasAttribute('data-srcset')) {
                    el.setAttribute("srcset",el.getAttribute("data-srcset"));
                    el.removeAttribute("data-srcset");
                }
            }
            if (transformations.oi) {
                let src = el.getAttribute('src');
                try {
                    let imgUrl = new URL(src);
                    console.log(`old image URL: ${src}`);
                    imgUrl.host = imgUrl.host.replaceAll(".","_")+".perfproxy.com";
                    imgUrl.searchParams.set("_oi","true");
                    console.log(`new image URL: ${imgUrl.href}`);
                    el.setAttribute('src',imgUrl.href);
                    if (el.hasAttribute('srcset')) {
                        el.setAttribute('srcset',el.getAttribute('srcset').replace(/https?:\/\/([^\/]*)\//,imgUrl.origin+'/'));
                    }
                } catch (e) {
                    console.log(`Unable to rewrite image src: ${src}`);
                }
                if (el.hasAttribute('data-src')) {
                    src = el.getAttribute('data-src');
                    try {
                        imgUrl = new URL(src);
                        console.log(`old image URL: ${src}`);
                        imgUrl.host = imgUrl.host.replaceAll(".","_")+".perfproxy.com";
                        imgUrl.searchParams.set("_oi","true");
                        console.log(`new image URL: ${imgUrl.href}`);
                        el.setAttribute('data-src',imgUrl.href);
                        if (el.hasAttribute('data-srcset')) {
                            el.setAttribute('data-srcset',el.getAttribute('srcset').replace(/https?:\/\/([^\/]*)\//,imgUrl.origin+'/'));
                        }
                    } catch (e) {
                        console.log(`Unable to rewrite image data-src: ${src}`);
                    }
                }
            }
        }
    })
    .on('link[rel="stylesheet"]', {
        element: el => {
            if (transformations.dc) {
                el.setAttribute("media","none");
                el.setAttribute("onload","this.media='all'");
            }
            if (transformations.rgf && el.hasAttribute('href') && el.getAttribute('href').includes('fonts.googleapis.com')) {
                el.remove();
            }
        }
    })
    .on('link[rel="preload"]', {
        element: el => {
            if (transformations.sc) {
                if (el.getAttribute("as") == "style") {
                    el.setAttribute("rel","stylesheet");
                    el.setAttribute("onload","");
                }
            }
        }
    })
    .on('html', {
        element: el => {
            if (transformations.hasOwnProperty('_th')) {
                transformations._th.forEach(element => {
                    el.prepend(element,{html:true});
                });
            }
        }
    })
    .on('head', {
        element: el => {
            if (transformations.hasOwnProperty('_ht')) {
                transformations._ht.forEach(element => {
                    el.prepend(element,{html:true});
                });
            }
            if (transformations.hasOwnProperty('_hb')) {
                transformations._hb.forEach(element => {
                    console.log(`Appending (bottom of head): ${element}`);
                    el.append(element,{html:true});
                });
            }
        }
    })
    .on('body', {
        element: el => {
            if (transformations.hasOwnProperty('_bt')) {
                transformations._bt.forEach(element => {
                    el.prepend(element,{html:true});
                });
            }
            if (transformations.hasOwnProperty('_bb')) {
                transformations._bb.forEach(element => {
                    el.append(element,{html:true});
                });
            }
        }
    })
    .on('style', {
        element: el => {
            if (transformations.ric) {
                el.remove();
            }
        }
    });
    if (transformations.hasOwnProperty('_fpl')) {
        transformations._fpl.forEach(qs => {
            hr.on(qs, {
                element: el => {
                    el.setAttribute('fetchpriority','high');
                    el.setAttribute('loading','eager');
                }
            });
        });
    }
    if (transformations.hasOwnProperty('_fph')) {
        transformations._fph.forEach(qs => {
            hr.on(qs, {
                element: el => {
                    el.setAttribute('fetchpriority','high');
                    el.setAttribute('loading','eager');
                }
            });
        });
    }
    return hr.transform(response);
}

addEventListener('fetch', event => {
  console.log(event.request.url);
  event.respondWith(handleRequest(event.request));
});
