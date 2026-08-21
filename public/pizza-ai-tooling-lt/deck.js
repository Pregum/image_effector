(() => {
  const slides = [...document.querySelectorAll('.slide')];
  const progress = document.querySelector('.progress i');
  const counter = document.querySelector('.counter');
  const video = document.getElementById('ending-video');
  const demoVideos = [...document.querySelectorAll('.demo-video')];
  let index = Math.max(0, Math.min(slides.length - 1, Number(location.hash.slice(1)) - 1 || 0));
  slides.forEach((slide) => slide.classList.remove('active'));

  function show(next, { replay = false } = {}) {
    next = Math.max(0, Math.min(slides.length - 1, next));
    slides[index]?.classList.remove('active');
    if (slides[index]?.classList.contains('video-slide')) video.pause();
    demoVideos.forEach((demo) => demo.pause());
    index = next;
    const slide = slides[index];
    slide.classList.add('active');
    location.hash = String(index + 1);
    progress.style.width = `${((index + 1) / slides.length) * 100}%`;
    counter.textContent = `${String(index + 1).padStart(2, '0')} / ${String(slides.length).padStart(2, '0')}`;

    if (slide.classList.contains('video-slide')) {
      slide.classList.remove('video-ended');
      if (replay || video.currentTime > .25) video.currentTime = 0;
      video.play().catch(() => {});
    }
    slide.querySelector('.demo-video')?.play().catch(() => {});
  }

  function fullscreen() {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen?.();
  }

  document.addEventListener('keydown', (event) => {
    if (['ArrowRight', 'ArrowDown', 'PageDown', ' '].includes(event.key)) {
      event.preventDefault(); show(index + 1);
    } else if (['ArrowLeft', 'ArrowUp', 'PageUp'].includes(event.key)) {
      event.preventDefault(); show(index - 1);
    } else if (event.key === 'Home') show(0);
    else if (event.key === 'End') show(slides.length - 1);
    else if (event.key.toLowerCase() === 'f') fullscreen();
    else if (event.key.toLowerCase() === 'r' && slides[index].classList.contains('video-slide')) show(index, { replay: true });
  });

  document.querySelector('.nav.prev').addEventListener('click', () => show(index - 1));
  document.querySelector('.nav.next').addEventListener('click', () => show(index + 1));
  video.addEventListener('ended', () => slides.at(-1).classList.add('video-ended'));
  video.addEventListener('click', () => show(index, { replay: true }));
  demoVideos.forEach((demo) => demo.addEventListener('click', () => {
    if (demo.paused) demo.play().catch(() => {});
    else demo.pause();
  }));
  window.addEventListener('hashchange', () => {
    const requested = Number(location.hash.slice(1)) - 1;
    if (Number.isInteger(requested) && requested !== index) show(requested);
  });
  show(index, { replay: true });
})();
