/* ============================================================================
   Screenshot capture for QA.

   A plain WebGL readback only gets the 3D layer — the whole HUD, the scope, the
   killcam bars and the loadout screen are DOM. So a capture is a composite:

     1. render one frame and read the WebGL canvas back (needs the render and the
        readback in the same task, before the compositor swaps the buffer)
     2. clone the overlay DOM, swap every <canvas> in the clone for an <img> of
        its pixels (cloneNode does not copy canvas contents), inline the
        stylesheet, and rasterise the lot through an SVG <foreignObject>
     3. draw (1) then (2) into a 2D canvas and POST it to the dev server

   The result is exactly what a player sees, saved as a real file.
   ========================================================================== */

let CSS_TEXT = null;
async function stylesheet() {
  if (CSS_TEXT === null) {
    try { CSS_TEXT = await (await fetch('/src/ui/style.css')).text(); }
    catch (e) { CSS_TEXT = ''; }
  }
  return CSS_TEXT;
}

/** Rasterise a DOM subtree at w x h. Returns an HTMLImageElement. */
async function domToImage(el, w, h) {
  const clone = el.cloneNode(true);

  // canvases: cloneNode copies the element but not the bitmap
  const srcCanvases = el.querySelectorAll('canvas');
  const dstCanvases = clone.querySelectorAll('canvas');
  for (let i = 0; i < srcCanvases.length; i++) {
    const src = srcCanvases[i], dst = dstCanvases[i];
    if (!dst || !dst.parentNode) continue;
    const img = document.createElement('img');
    try { img.setAttribute('src', src.toDataURL('image/png')); } catch (e) { continue; }
    for (const a of dst.attributes) img.setAttribute(a.name, a.value);
    const cs = getComputedStyle(src);
    img.setAttribute('style', (dst.getAttribute('style') || '') +
      `;width:${cs.width};height:${cs.height};display:block`);
    dst.parentNode.replaceChild(img, dst);
  }

  /* Strip comment nodes. The markup uses long ==== rules inside HTML comments,
     and a double hyphen is illegal inside an XML comment, so XMLSerializer
     happily emits something the SVG parser then rejects outright. */
  const walker = document.createTreeWalker(clone, NodeFilter.SHOW_COMMENT);
  const comments = [];
  while (walker.nextNode()) comments.push(walker.currentNode);
  for (const c of comments) c.parentNode && c.parentNode.removeChild(c);

  const css = await stylesheet();
  const body = new XMLSerializer().serializeToString(clone);
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">` +
    `<foreignObject x="0" y="0" width="${w}" height="${h}">` +
    `<div xmlns="http://www.w3.org/1999/xhtml" style="width:${w}px;height:${h}px;position:relative;margin:0">` +
    `<style>/*<![CDATA[*/${css}/*]]>*/</style>${body}</div>` +
    `</foreignObject></svg>`;

  const url = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  const img = new Image();
  img.width = w; img.height = h;
  await new Promise((res, rej) => {
    img.onload = res;
    img.onerror = () => rej(new Error('foreignObject rasterise failed'));
    img.src = url;
  });
  return img;
}

/**
 * Capture the current frame (3D + overlay) and save it as qa/<name>.jpg.
 * @param name    file name without extension
 * @param opts    { overlay: element id to composite (default the visible one) }
 */
export async function capture(name, opts = {}) {
  const R = window.__renderer;
  const gl = R.domElement;
  const w = gl.width, h = gl.height;

  // 1. fresh frame, read back immediately — same task, before the swap.
  //    opts.noStep renders without advancing the simulation, so a scene can be
  //    posed deliberately and photographed without the match moving under it.
  const noRender = window.__noRender;
  window.__noRender = false;
  if (opts.noStep) {
    window.__renderer.shadowMap.needsUpdate = true;
    window.__renderer.clear();
    window.__renderer.render(window.__scene, window.__game.camera);
    window.__viewmodel.render(window.__renderer, window.__game.camera.aspect, 1);
  } else {
    window.__step(1 / 60);
  }
  let glData = null;
  try { glData = gl.toDataURL('image/png'); } catch (e) { glData = null; }
  window.__noRender = noRender;

  const out = document.createElement('canvas');
  out.width = w; out.height = h;
  const ctx = out.getContext('2d');
  ctx.fillStyle = '#0a0d0c';
  ctx.fillRect(0, 0, w, h);

  if (glData) {
    const bg = new Image();
    await new Promise(res => { bg.onload = res; bg.onerror = res; bg.src = glData; });
    ctx.drawImage(bg, 0, 0, w, h);
  }

  // 2. overlay: the loadout screen, or the HUD, whichever is up
  const ids = opts.overlay ? [opts.overlay]
    : ['menu', 'hud', 'result', 'pause'].filter(id => {
        const e = document.getElementById(id);
        return e && !e.classList.contains('hidden');
      });
  for (const id of ids) {
    const el = document.getElementById(id);
    if (!el) continue;
    try {
      // lay the overlay out at the capture resolution, not the pane's size, so
      // the composite is what a 1080p player actually sees
      const img = await domToImage(el, w, h);
      ctx.drawImage(img, 0, 0, w, h);
    } catch (e) {
      console.warn('[qa] overlay ' + id + ' did not rasterise:', e.message);
    }
  }

  // 3. ship it
  const data = out.toDataURL('image/jpeg', 0.88);   // ~10x smaller than PNG at 1080p
  const res = await fetch('/_qa/' + encodeURIComponent(name), { method: 'POST', body: data });
  const bytes = await res.text();
  return { name, width: w, height: h, bytes: Number(bytes) || 0, hadGL: !!glData, overlays: ids };
}

/** Put the renderer at a fixed capture resolution. */
export function setCaptureSize(w, h) {
  const R = window.__renderer, g = window.__game;
  R.setSize(w, h, false);
  g.camera.aspect = w / h;
  g.camera.updateProjectionMatrix();
  window.__effects.setPixelScale(h);
  return [R.domElement.width, R.domElement.height];
}

/**
 * Put the renderer back to the window's size after a capture session.
 *
 * setCaptureSize() resizes the real renderer and nothing reset it: a frame-time
 * run taken straight after a 1920x1080 capture measured 1920x1080, while the
 * run before it had measured the window, and the two looked like a regression.
 */
export function restoreCaptureSize() {
  return setCaptureSize(window.innerWidth, window.innerHeight);
}
