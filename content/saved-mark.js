// showSavedMark is passed to chrome.scripting.executeScript and runs in the
// page where the user chose "Save to FoldTube". Like scrapeYouTubeTab, it must
// stay self-contained: no imports, no references to outer variables.
//
// It shows a short "Saved" pill over the link that was right-clicked (the
// largest visible one, so a thumbnail wins over a title), or at the bottom of
// the screen if that link can't be found. Built with DOM calls and the Web
// Animations API, inside a closed shadow root, so the page's styles and its
// Content Security Policy don't get in the way.
export function showSavedMark(linkUrl, { added, iconUrl } = {}) {
  const HOST_ID = 'foldtube-saved-mark';
  document.getElementById(HOST_ID)?.remove();

  // The right-clicked link: same address, on screen, the biggest one.
  let target = null;
  let bestArea = 0;
  for (const a of document.querySelectorAll('a[href]')) {
    if (a.href !== linkUrl) continue;
    const r = a.getBoundingClientRect();
    const visible = r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;
    const area = r.width * r.height;
    if (visible && area > bestArea) { target = r; bestArea = area; }
  }

  const host = document.createElement('div');
  host.id = HOST_ID;
  // all: initial first: the page's inherited text styles (letter-spacing,
  // uppercase, direction) would otherwise reach into the shadow root.
  Object.assign(host.style, {
    all: 'initial', position: 'fixed', inset: '0', zIndex: '2147483647', pointerEvents: 'none',
  });
  const root = host.attachShadow({ mode: 'closed' });

  const pill = document.createElement('div');
  Object.assign(pill.style, {
    position: 'absolute', display: 'flex', alignItems: 'center', gap: '8px',
    padding: '7px 14px 7px 8px', borderRadius: '999px',
    background: 'rgba(18, 18, 18, 0.92)', color: '#fff',
    font: '600 14px/1.2 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif',
    boxShadow: '0 4px 16px rgba(0, 0, 0, 0.35)', whiteSpace: 'nowrap',
    transform: 'translate(-50%, -50%)',
  });

  if (iconUrl) {
    const icon = document.createElement('img');
    icon.src = iconUrl;
    icon.alt = '';
    Object.assign(icon.style, {
      width: '22px', height: '22px', padding: '2px', boxSizing: 'border-box',
      borderRadius: '6px', background: '#fff', display: 'block',
    });
    icon.onerror = () => icon.remove();
    pill.append(icon);
  }
  const label = document.createElement('span');
  label.textContent = added ? 'Saved to FoldTube' : 'Already in FoldTube';
  pill.append(label);

  if (target) {
    // Kept on screen, even in a frame narrower than the pill.
    const padX = Math.min(100, innerWidth / 2);
    const padY = Math.min(24, innerHeight / 2);
    pill.style.left = `${Math.min(Math.max(target.left + target.width / 2, padX), innerWidth - padX)}px`;
    pill.style.top = `${Math.min(Math.max(target.top + target.height / 2, padY), innerHeight - padY)}px`;
  } else {
    pill.style.left = '50%';
    pill.style.top = `${innerHeight - 48}px`;
  }

  root.append(pill);
  document.documentElement.append(host);

  const shown = { opacity: 1, transform: 'translate(-50%, -50%) scale(1)' };
  const hidden = { opacity: 0, transform: 'translate(-50%, -50%) scale(0.85)' };
  pill.animate([hidden, shown], { duration: 180, easing: 'cubic-bezier(.2,.9,.3,1.3)', fill: 'forwards' });
  setTimeout(() => {
    const out = pill.animate([shown, hidden], { duration: 220, easing: 'ease-in', fill: 'forwards' });
    out.onfinish = () => host.remove();
  }, 1800);
  return true;
}
