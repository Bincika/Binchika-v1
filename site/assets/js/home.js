// Progressive enhancement only. Public data and the map are owned by their existing modules.
const scene = document.querySelector('[data-evidence-scene]');
if (scene) {
  const cards = [...scene.querySelectorAll('[data-evidence-card]')];
  const status = document.getElementById('home-evidence-status');
  const pause = document.querySelector('[data-depth-pause]');
  const copy = {
    photo: 'Photograph the posted result sheet, never people. Public reporting is still closed.',
    compare: "Compare independent reports with INEC's IReV upload. A mismatch is flagged with its sources and reason.",
    ledger: 'Examine the published record and its confidence rules. Only INEC declares results.',
  };
  for (const card of cards) card.addEventListener('click', () => {
    for (const other of cards) other.setAttribute('aria-pressed', String(other === card));
    if (status) status.textContent = copy[card.dataset.evidenceCard];
  });

  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const capable = matchMedia('(min-width: 901px) and (hover: hover) and (pointer: fine)');
  const connection = navigator.connection;
  let paused = false, visible = false, eligible = false, frame = 0, point = null;
  const reset = () => {
    if (frame) cancelAnimationFrame(frame);
    frame = 0; point = null;
    scene.style.removeProperty('--scene-rx'); scene.style.removeProperty('--scene-ry');
  };
  const update = () => {
    eligible = capable.matches && !reduced.matches && !connection?.saveData && (!navigator.deviceMemory || navigator.deviceMemory >= 4);
    if (pause) pause.hidden = !eligible;
    if (!eligible) reset();
  };
  const draw = () => {
    frame = 0;
    if (!point || !eligible || paused || !visible || document.hidden) return;
    const box = scene.getBoundingClientRect();
    const bound = value => Math.max(-4, Math.min(4, value));
    scene.style.setProperty('--scene-ry', bound((point.x - box.left) / box.width * 8 - 4).toFixed(2) + 'deg');
    scene.style.setProperty('--scene-rx', bound(4 - (point.y - box.top) / box.height * 8).toFixed(2) + 'deg');
  };
  scene.addEventListener('pointermove', event => {
    if (!eligible || paused || !visible || document.hidden || event.pointerType === 'touch') return;
    point = {x: event.clientX, y: event.clientY};
    if (!frame) frame = requestAnimationFrame(draw);
  }, {passive: true});
  scene.addEventListener('pointerleave', reset);
  pause?.addEventListener('click', () => {
    paused = !paused; pause.setAttribute('aria-pressed', String(paused));
    pause.textContent = paused ? 'Resume depth' : 'Pause depth'; reset();
  });
  const observer = new IntersectionObserver(entries => {
    visible = entries[0].isIntersecting;
    if (!visible) reset();
  });
  observer.observe(scene);
  document.addEventListener('visibilitychange', () => {if (document.hidden) reset();});
  reduced.addEventListener('change', update); capable.addEventListener('change', update);
  connection?.addEventListener?.('change', update);
  update();
}
