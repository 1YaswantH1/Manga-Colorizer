'use strict';
if (window.injectedMC !== 1) {
    window.injectedMC = 1;
    console.log('[MC] Starting context script');
    var activeFetches = 0;

    var maxActiveFetches = 1;  // Number of images to request and process parallely
    var colorTolerance = 30;  // If difference between red, blue, and green values is greater than this for any pixel,
                      // image is assumed to be in color and will not be recolored.
    var colorStride = 4; // When checking for an already-colored image,
                         // skip this many rows and columns at edges and between pixels.
                         // Check every pixel for color if zero.
    var cache = false
    var denoise = true
    var colorize = true
    var upscale = true
    var upscaleFactor = 4  // Image upscale factor x2 or x4
    var denoiseSigma = 25  // Expected noise in image

    var showOriginal = false
    var showColorized = true

    var siteConfigFile = 'siteConfig.json'
    let siteConfigurations = null;

    function fetchSiteConfigurations() {
        return fetch(browser.runtime.getURL(siteConfigFile))
            .then(response => response.json());
    }
    fetchSiteConfigurations().then(config => {
        siteConfigurations = config
        console.log('[MC] Sites configuration loaded')
    });

    String.prototype.rsplit = function(sep, maxsplit) {
        const split = this.split(sep);
        return maxsplit ? [ split.slice(0, -maxsplit).join(sep) ].concat(split.slice(-maxsplit)) : split;
    }

    function injectCSS() {
        const css = `
            .isHidden {
                display: none !important;
            }
        `;
        const style = document.createElement('style');
        style.type = 'text/css';
        style.textContent = css;
        document.head.appendChild(style);
    }
    injectCSS();

    function toggleImageVisibility(showOriginal, showColorized) {
        const coloredImages = document.querySelectorAll('img[data-is-colored="true"][data-in-view="true"]');
        const clonedImages = document.querySelectorAll('img[data-is-cloned="true"][data-in-view="true"]');

        coloredImages.forEach(img => {
            showColorized ? img.classList.remove('isHidden') : img.classList.add('isHidden')
        });

        clonedImages.forEach(img => {
            showOriginal ? img.classList.remove('isHidden') : img.classList.add('isHidden')
        });
    }

    function parseQuery(queryString, doc = document) {
        queryString = queryString.trim();

        const querySelectorRegex = /^document\.querySelector(All)?\(['"](.+?)['"]\)/;
        const indexRegex = /\[(\d+)\]/;
        const propertyRegex = /\.(innerText|innerHTML|textContent)$/;

        let queryResult = null;

        try {
            const selectorMatch = queryString.match(querySelectorRegex);
            if (!selectorMatch) throw new Error('Invalid selector format');
            const isAll = Boolean(selectorMatch[1]);
            const selector = selectorMatch[2];

            queryResult = isAll ? doc.querySelectorAll(selector) : doc.querySelector(selector);

            if (isAll) {
                const indexMatch = queryString.match(indexRegex);
                const index = indexMatch[1] !== undefined ? parseInt(indexMatch[1], 10) : 0;
                queryResult = queryResult[index];
            }

            if (!queryResult) return '';

            const propertyMatch = queryString.match(propertyRegex);
            if (propertyMatch && propertyMatch[1]) {
                return queryResult[propertyMatch[1]] || '';
            } else {
                return '';
            }
        } catch (error) {
            console.error(`[MC] Error parsing query: ${queryString}`, error);
            return '';
        }
    }


    const maxDistFromGray = (ctx) => {
        const bpp = 4 // Bytes per pixel = number of channels (RGBA)
        const rows = ctx.canvas.height - colorStride * 2;
        const cols = ctx.canvas.width - colorStride * 2;
        // Skip first and last colorStride rows and columns when getting data
        const imageData = ctx.getImageData(colorStride, colorStride, cols, rows);
        const rowStride = colorStride + 1;
        const rowBytes = cols * bpp;
        const pxStride = bpp * (colorStride + 1); 
        var maxDist = 0;
        for (let row = 0; row < rows; row += rowStride) {
            const rowStart = row * rowBytes;
            const rowEnd = rowStart + rowBytes;
            for (let i = rowStart; i < rowEnd; i += pxStride) {
                const red = imageData.data[i];
                const green = imageData.data[i + 1];
                const blue = imageData.data[i + 2];
                maxDist = Math.max(Math.abs(red-blue), Math.abs(red-green), Math.abs(blue-green), maxDist)
            }
        }
        console.log('[MC] Max distance from gray: ', maxDist)
        return maxDist;
    }

    const isColoredContext = (ctx) => {
        return (colorTolerance < 255) && maxDistFromGray(ctx) > colorTolerance;
    }

    // Backup code:
    /*async function fetchColorizedImg(url, options, img, imgName) {
        console.log('[MC] Fetching: ', url, imgName);
        return fetch(url, options)
            .then(response => {
                if(!response.ok)
                    return response.text().then(text => {throw text})
                else
                    return response.json()})
            .then(json => {
                if (json.msg)
                    console.log('[MC] Message: ', json.msg);
                if (json.colorImgData) {
                    img.coloredsrc = json.colorImgData.slice(0, maxColoredSrc);
                    img.src = json.colorImgData;
                    if (img.dataset?.src) img.dataset.src = '';
                    if (img.srcset) img.srcset = '';
                    console.log('[MC] Processed: ', imgName);
                }
            })
            .catch(error => {
                console.log('[MC] Fetch error: ', error);
            });
    }*/

    async function fetchColorizedImg(url, options, img, imgName) {
    console.log('[MC] Fetching: ', url, imgName);
    return fetch(url, options)
        .then(response => {
            if (!response.ok)
                return response.text().then(text => { throw text })
            else
                return response.json()
        })
        .then(json => {
            if (json.msg)
                console.log('[MC] Message: ', json.msg);
            if (json.colorImgData) {
                const imgClone = img.cloneNode(true);
                img.dataset.isColored = true;
                imgClone.dataset.isCloned = true;

                img.src = json.colorImgData;
                if (img.dataset?.src) img.dataset.src = '';
                if (img.srcset) img.srcset = '';

                img.parentNode.insertBefore(imgClone, img.nextSibling);

                img.dataset.inView = img.style.display !== 'none'
                imgClone.dataset.inView = imgClone.style.display !== 'none'

                observeImageChanges(img, imgClone);

                console.log('[MC] Processed: ', imgName);
                toggleImageVisibility(showOriginal, showColorized)
            }
        })
        .catch(error => {
            console.log('[MC] Fetch error: ', error);
        });
    }


    const canvasContextFromImg = (img) => {
        const imgCanvas = document.createElement("canvas");
        imgCanvas.width = img.width;
        imgCanvas.height = img.height;

        const imgContext = imgCanvas.getContext("2d", { willReadFrequently: true });
        imgContext.drawImage(img, 0, 0, imgCanvas.width, imgCanvas.height);
        return imgContext
    }

    const setColoredOrFetch = (img, imgName, apiURL, colorStride, imgContext, mangaProps) => {
        var canSendData = true;
        try {
            if (isColoredContext(imgContext, colorStride)) {
                img.dataset.isColored = true;
                console.log('[MC] Already colored: ', imgName);
                return 1;
            }
        } catch(eIsColor) {
            canSendData = false
            if (!eIsColor.message.startsWith("Failed to execute 'getImageData'")) {
                console.log('[MC] Colorized context error: ', eIsColor)
                return 0;
            }
        }

        if (activeFetches < maxActiveFetches) {
            activeFetches += 1;
            img.dataset.isProcessed = true;
            const postData = {
                imgName: imgName,
                imgWidth: img.width,
				imgHeight: img.height,
				cache: cache,
				denoise: denoise,
				colorize: colorize,
				upscale: upscale,
				denoiseSigma: Number(denoiseSigma),
				upscaleFactor: Number(upscaleFactor),

				mangaTitle: mangaProps.title,
				mangaChapter: mangaProps.chapter,
            }

            console.log('[MC] Sending: ', postData)

            if (canSendData)
                postData.imgData = imgContext.canvas.toDataURL("image/png");
            else
                postData.imgURL = img.src;

            const options = {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(postData)
            };

            fetchColorizedImg(new URL('colorize-image-data', apiURL).toString(), options, img, imgName)
                .finally(() => {
                    activeFetches -= 1;
                    colorizeMangaEventHandler();
                });
            return 3
        } else {
            return 2;
        }
    }

    const colorizeImg = (img, apiURL, colorStride, mangaProps) => {
        if (apiURL) try {
            const imageName = mangaProps.altText ? img.alt : ''
            const imgName = imageName || (img.src || img.dataset?.src || '').rsplit('/', 1)[1];
            if (imgName) {
                let imgContext = canvasContextFromImg(img);
                return setColoredOrFetch(img, imgName, apiURL, colorStride, imgContext, mangaProps);
            }
            return 0;
        } catch(e) {
            console.log('[MC] Colorize image error: ', e)
            return 0;
        }
    }

    const colorizeMangaEventHandler = (event=null) => {
        try {
            browser.storage.local.get(["apiURL", "maxActiveFetches", "showOriginal", "showColorized", "cache", "denoise", "colorize", "upscale", "denoiseSigma", "upscaleFactor",
                "colorTolerance", "colorStride", "minImgHeight", "minImgHeight"], (result) => {
                const apiURL = result.apiURL;
                if (apiURL && siteConfigurations) {
                    maxActiveFetches = Number(result.maxActiveFetches || "1")
                    showOriginal = result.showOriginal
                    showColorized = result.showColorized

                    cache = result.cache
                    denoise = result.denoise
                    colorize = result.colorize
                    upscale = result.upscale
                    denoiseSigma = result.denoiseSigma || "25"
                    upscaleFactor = result.upscaleFactor || "4"

                    const storedColorTolerance = result.colorTolerance;
                    const storedColorStride = result.colorStride;
                    const minImgHeight = Math.min(result.minImgHeight || 200, window.innerHeight/2);
                    const minImgWidth = Math.min(result.minImgWidth || 400, window.innerWidth/2);

                    if (storedColorTolerance > -1) colorTolerance = storedColorTolerance;
                    if (storedColorStride > -1) colorStride = storedColorStride;

                    const site = Object.keys(siteConfigurations).find(site => window.location.hostname.includes(site));
                    const config = siteConfigurations[site];
                    const title = site ? parseQuery(config.titleQuery) : '';
                    const chapter = site ? parseQuery(config.chapterQuery) : '';
                    const pageNameFromAltText = site ? config.useAltTextAsImageName : false

                    console.log(`[MC] Website: ${site}, Title: ${title}, Chapter: ${chapter}`)
                    console.log('[MC] Scanning images...')
                    toggleImageVisibility(showOriginal, showColorized)

                    let total = 0;
                    let skipped = 0;
                    let colored = 0;
                    let failed = 0;
                    let awaited = 0;
                    let processing = 0;

                    const images = document.querySelectorAll('img');
                    total= images.length;

                    images.forEach((img, index) => {
                        if (img.dataset.isCloned) {
                            return  // continue
                        } else if (img.dataset.isColored) {
                            colored++
                        } else if(img.dataset.isProcessed && !img.dataset.isColored){
                            failed++
                        } else if (!img.complete || !img.src) {
                            img.addEventListener('load', colorizeMangaEventHandler, { passive: true });
                            total--
                        } else if (img.width > 0 && img.width < minImgWidth || img.height > 0 && img.height < minImgHeight) {
                            skipped++
                        } else {
                            const mangaProps = {title: title, chapter: chapter, altText: pageNameFromAltText}
                            let status = colorizeImg(img, apiURL, colorStride, mangaProps);
                            switch(status){
                                case 0: failed++; break;
                                case 1: colored++; break;
                                case 2: awaited++; break;
                                case 3: processing++; break;
                            }
                        }
                    });
                    console.log(`[MC] Report: Processing=${processing} Success=${colored} Skipped=${skipped} Failed=${failed} Awaited=${awaited} Total=${total}`)
                }
            });
        } catch (err) {
            if (err.toString().includes('Extension context invalidated')) {
                console.log('[MC] Extension reloaded, stopping old version');
                window.injectedMC = undefined;
                observer?.disconnect();
            } else {
                console.error('[MC] Error: ', err);
            }
        }
    }


    function observeImageChanges(originalImg, clonedImg) {
        const handleMutation = (mutationsList) => {
            mutationsList.forEach((mutation) => {
                if (mutation.type === 'attributes' && mutation.attributeName === 'style') {
                    clonedImg.style.cssText = originalImg.style.cssText;

                    if (originalImg.style.display !== 'none'){
                        originalImg.dataset.inView = true
                        clonedImg.dataset.inView = true
                    } else if(originalImg.style.display === 'none'){
                        originalImg.dataset.inView = false
                        clonedImg.dataset.inView = false
                    }
                }

                if (mutation.type === 'childList') {
                    mutation.removedNodes.forEach((node) => {
                        if (node === originalImg) {
                            clonedImg.remove();
                            observer.disconnect();
                        }
                    });
                }
            });
        };

        const observer = new MutationObserver(handleMutation);
        observer.observe(originalImg, { attributes: true, attributeFilter: ['style'] });
        observer.observe(originalImg.parentNode, { childList: true });
        originalImg._observer = observer;
    }

    colorizeMangaEventHandler();

    const observer = new MutationObserver(colorizeMangaEventHandler);
    observer.observe(document.querySelector("body"), { subtree: true, childList: true });

    browser.runtime.onMessage.addListener((request, sender, sendResponse) => {
        if (request.action === 'toggleVisibility') {
            console.log('[MC] Image visibility toggled')
            toggleImageVisibility(request.showOriginal, request.showColorized);
        }
        if (request.action === 'runColorizer'){
            console.log('[MC] Running colorizer')
            colorizeMangaEventHandler();
        }
        sendResponse({status: 'done'});
    });
};
