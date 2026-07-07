import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';

const MODEL_URL = './assets/novabeast.glb';

const statusEl = document.getElementById('status');
const listEl = document.getElementById('list');
const filterEl = document.getElementById('filter');
const countEl = document.getElementById('count');
const outputEl = document.getElementById('output');
const copyBtn = document.getElementById('copy-btn');
const copyFeedback = document.getElementById('copy-feedback');
const selectAllBtn = document.getElementById('select-all');
const selectNoneBtn = document.getElementById('select-none');

const dracoLoader = new DRACOLoader();
dracoLoader.setDecoderPath('https://unpkg.com/three@0.165.0/examples/jsm/libs/draco/');

const loader = new GLTFLoader();
loader.setDRACOLoader(dracoLoader);

function updateOutput() {
  const checked = [...listEl.querySelectorAll('input[type="checkbox"]:checked')].map(
    (el) => el.dataset.name
  );
  outputEl.value = checked.join('\n');
  countEl.textContent = `${checked.length} selected / ${listEl.children.length} total`;
}

function applyFilter() {
  const query = filterEl.value.trim().toLowerCase();
  listEl.querySelectorAll('.clip-row').forEach((row) => {
    const matches = !query || row.dataset.name.toLowerCase().includes(query);
    row.classList.toggle('hidden', !matches);
  });
}

loader.load(
  MODEL_URL,
  (gltf) => {
    const clips = gltf.animations || [];
    statusEl.textContent = `${clips.length} animation clip${clips.length === 1 ? '' : 's'} found.`;

    // Duplicate clip names are common in these exports (VRCFury/blend-shape
    // clips reused across meshes) — keep every entry distinct by index so
    // selecting one doesn't accidentally also select same-named others, but
    // the exported list is by name, matching what filter_animations.py reads.
    clips.forEach((clip, i) => {
      const row = document.createElement('div');
      row.className = 'clip-row';
      row.dataset.name = clip.name;

      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.id = `clip-${i}`;
      checkbox.dataset.name = clip.name;
      checkbox.addEventListener('change', updateOutput);

      const label = document.createElement('label');
      label.htmlFor = `clip-${i}`;
      label.textContent = clip.name;

      row.appendChild(checkbox);
      row.appendChild(label);
      listEl.appendChild(row);
    });

    updateOutput();
  },
  (progress) => {
    if (progress.total) {
      const pct = Math.round((progress.loaded / progress.total) * 100);
      statusEl.textContent = `Loading assets/novabeast.glb… ${pct}%`;
    }
  },
  (error) => {
    console.error('Failed to load model:', error);
    statusEl.textContent = 'Failed to load model — see console for details.';
  }
);

selectAllBtn.addEventListener('click', () => {
  listEl.querySelectorAll('.clip-row:not(.hidden) input').forEach((el) => {
    el.checked = true;
  });
  updateOutput();
});

selectNoneBtn.addEventListener('click', () => {
  listEl.querySelectorAll('.clip-row:not(.hidden) input').forEach((el) => {
    el.checked = false;
  });
  updateOutput();
});

filterEl.addEventListener('input', applyFilter);

copyBtn.addEventListener('click', async () => {
  await navigator.clipboard.writeText(outputEl.value);
  copyFeedback.classList.add('show');
  setTimeout(() => copyFeedback.classList.remove('show'), 1200);
});
