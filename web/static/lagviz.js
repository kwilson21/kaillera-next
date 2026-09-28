/**
 * lagviz.js — the waking-state input-lag visualizer (same mechanics as
 * /lag-test.html). Shared by the front page and the invite page.
 *
 * Expects #viz (with #viz-send inside), #p-in, #p-out, #v-in, #v-out, #verdict, #verdict-sub, #lag,
 * #lag-out and #rb in the page.
 * Exposes: window.KNLagViz.init(isActive) — isActive() gates the global SPACE key.
 */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);

  function init(isActive) {
    let lag = 120;
    let rollback = true;
    const verdict = () => {
      const v = $('verdict');
      const sub = $('verdict-sub');
      if (lag === 0) {
        v.textContent = 'No network lag';
        v.className = 'verdict ok';
        sub.textContent = 'Nothing to hide. Raise the slider.';
      } else if (rollback) {
        v.textContent = 'Round trip hidden';
        v.className = 'verdict ok';
        sub.textContent = `${lag} ms each way is still on the wire. Rollback predicts past it locally, so you don't wait.`;
      } else {
        v.textContent = `${lag * 2} ms wait per input`;
        v.className = 'verdict bad';
        sub.textContent = `Lockstep waits a full round trip on every input. ${lag} ms each way = ${lag * 2} ms before you see the response.`;
      }
    };
    const flash = (node, late) => {
      node.classList.remove('lit', 'late');
      void node.offsetHeight;
      if (late) node.classList.add('late');
      node.classList.add('lit');
    };
    const press = () => {
      const t0 = performance.now();
      flash($('p-in'), false);
      $('v-in').textContent = '0 ms';
      const wait = rollback ? 0 : lag * 2;
      if (!wait) {
        flash($('p-out'), false);
        $('v-out').textContent = '0 ms';
        return;
      }
      $('v-out').textContent = 'wait…';
      setTimeout(() => {
        flash($('p-out'), wait > 50);
        $('v-out').textContent = `+${Math.round(performance.now() - t0)} ms`;
      }, wait);
    };
    $('lag').addEventListener('input', (e) => {
      lag = Number(e.target.value) || 0;
      $('lag-out').textContent = `${lag} ms`;
      verdict();
    });
    $('rb').addEventListener('change', (e) => {
      rollback = e.target.checked;
      verdict();
    });
    const viz = $('viz');
    // Tap anywhere on it; keyboard users have SPACE anywhere on the page and
    // the Send button (a real button, so the controls aren't nested in one).
    viz.addEventListener('click', (e) => {
      if (!e.target.closest('input, label')) press();
    });
    document.addEventListener('keydown', (e) => {
      if (e.code !== 'Space' || e.repeat || !isActive()) return;
      if (e.target.closest('input, button, a, textarea, [role="button"]')) return;
      e.preventDefault();
      press();
    });
    verdict();
  }

  window.KNLagViz = { init };
})();
