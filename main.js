import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';

const MODEL_URL = './assets/rewrite.glb';

const canvas = document.getElementById('viewer-canvas');
const loadingEl = document.getElementById('loading');

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x1a1a1e);

const camera = new THREE.PerspectiveCamera(
  40,
  window.innerWidth / window.innerHeight,
  0.01,
  100
);
camera.position.set(0, 1.4, 3.2);

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
// No tone mapping: unlit materials should show the texture's exact color,
// and ACES/Reinhard curves would otherwise shift/compress those values.
renderer.toneMapping = THREE.NoToneMapping;

// Environment for real-reflection materials (like "metal" below): a flat
// grey box only ever reflects grey, no matter the roughness, since there's
// no color information to bounce back — real metal picks up color from a
// varied surrounding (sky, floor, nearby colored objects). This builds a
// small stylized "room" with a cool blue sky-ish ceiling, a warm floor, and
// a couple of colored accent panels alongside bright highlight strips, so
// the metal's reflection actually carries some blue/red/warm variation.
function buildMetalEnvironment() {
  const envScene = new THREE.Scene();

  const room = new THREE.Mesh(
    new THREE.BoxGeometry(12, 12, 12),
    new THREE.MeshBasicMaterial({ color: 0x3a3a40, side: THREE.BackSide })
  );
  envScene.add(room);

  const ceiling = new THREE.Mesh(
    new THREE.PlaneGeometry(12, 12),
    new THREE.MeshBasicMaterial({ color: 0x3d6fb8 })
  );
  ceiling.rotation.x = Math.PI / 2;
  ceiling.position.y = 5.9;
  envScene.add(ceiling);

  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(12, 12),
    new THREE.MeshBasicMaterial({ color: 0xb8834a })
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -5.9;
  envScene.add(floor);

  const stripGeometry = new THREE.PlaneGeometry(0.6, 8);
  const accentGeometry = new THREE.PlaneGeometry(3, 4);

  const panels = [
    { geo: stripGeometry, color: 0xffffff, x: -3, y: 0, z: -5.9, ry: 0 },
    { geo: stripGeometry, color: 0xffffff, x: 3, y: 0, z: -5.9, ry: 0 },
    { geo: accentGeometry, color: 0xe0483a, x: -5.9, y: 1, z: -1, ry: Math.PI / 2 },
    { geo: accentGeometry, color: 0x4ab0c8, x: 5.9, y: 1, z: 2, ry: -Math.PI / 2 },
  ];

  panels.forEach(({ geo, color, x, y, z, ry }) => {
    const panel = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color }));
    panel.position.set(x, y, z);
    panel.rotation.y = ry;
    envScene.add(panel);
  });

  return envScene;
}

const pmremGenerator = new THREE.PMREMGenerator(renderer);
const envTexture = pmremGenerator.fromScene(buildMetalEnvironment(), 0.02).texture;

// A single, fairly bright directional light so the reflective material has
// something to catch a visible highlight from, without lighting the rest of
// the (unlit) avatar since only the metal material below receives lights.
const metalHighlight = new THREE.DirectionalLight(0xffffff, 2.2);
metalHighlight.position.set(2, 4, 3);
scene.add(metalHighlight);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.target.set(0, 1.0, 0);
controls.minDistance = 0.3;
controls.maxDistance = 10;
controls.update();

const grid = new THREE.GridHelper(6, 24, 0x444444, 0x2a2a2a);
scene.add(grid);

let mixer = null;
const clock = new THREE.Clock();

// lilToon's goggle lens is a near-opaque MASK-cutout material with a very
// low baseColor alpha (meant as a faint glass tint in-engine), but carried
// over literally it renders as a dark smudge that blocks the eyes behind it.
// Simplest correct fix for this viewer: don't render it at all.
const HIDDEN_MATERIAL_NAMES = ['lensMat 1'];

// "metal" ships with no base texture and relies on real PBR reflections to
// read as metal — since the rest of the avatar is unlit by design, it would
// otherwise render as plain white. Rather than flatly tinting it, give it a
// real lit/reflective material (see metalHighlight light + envTexture above)
// so it actually looks like shiny metal instead of grey plastic.
const REAL_MATERIAL_NAMES = ['metal'];

// Some flat-color materials ship with baseColorFactor set to pure black (no
// texture at all), relying on lilToon shading effects in Unity that don't
// carry over here — "leather" is meant to look dark brown, not pure black.
const MATERIAL_COLOR_OVERRIDES = {
  leather: 0x110b09,
};

// Render the avatar unlit: swap every material for a MeshBasicMaterial that
// keeps the original texture/color/alpha but does zero light computation, so
// what you see is exactly the source texture's albedo (no PBR roughness/
// metalness guesses from the lilToon->glTF conversion involved at all).
function makeUnlit(root) {
  root.traverse((obj) => {
    if (!obj.isMesh) return;
    const materials = Array.isArray(obj.material) ? obj.material : [obj.material];

    const converted = materials.map((mat) => {
      if (!mat) return mat;

      if (HIDDEN_MATERIAL_NAMES.includes(mat.name)) {
        const hidden = new THREE.MeshBasicMaterial({ name: mat.name, visible: false });
        mat.dispose();
        return hidden;
      }

      if (REAL_MATERIAL_NAMES.includes(mat.name)) {
        const metal = new THREE.MeshStandardMaterial({
          color: 0xffffff,
          metalness: 1,
          roughness: 0.25,
          envMap: envTexture,
          envMapIntensity: 1.0,
          name: mat.name,
        });
        mat.dispose();
        return metal;
      }

      const colorOverride = MATERIAL_COLOR_OVERRIDES[mat.name];

      const basic = new THREE.MeshBasicMaterial({
        map: mat.map || null,
        color: colorOverride !== undefined
          ? new THREE.Color(colorOverride)
          : (mat.color ? mat.color.clone() : new THREE.Color(0xffffff)),
        transparent: mat.transparent,
        opacity: mat.opacity,
        alphaTest: mat.alphaTest,
        side: mat.side,
        name: mat.name,
      });

      mat.dispose();
      return basic;
    });

    obj.material = Array.isArray(obj.material) ? converted : converted[0];
  });
}

// Toon outline via the standard "inverted hull" trick: a back-face-only
// duplicate of each mesh, pushed outward along vertex normals in the vertex
// shader, drawn in a flat dark color. This is the same technique lilToon
// itself uses for its outline pass in VRChat, so it matches the source look.
//
// This avatar hides its goggles via a blend shape ("hideGoggles") with a
// default weight of 1 baked into the glb (mesh.weights), applied at runtime
// via morph targets — not baked into the rest-pose position. The outline
// mesh must therefore run the same morph target math as the base mesh
// (morphtarget_pars_vertex / morphtarget_vertex chunks below), or it renders
// the un-morphed position and shows a ghost outline where the goggles would
// be if not hidden.
const OUTLINE_VERTEX_SHADER = `
  #include <morphtarget_pars_vertex>
  #include <skinning_pars_vertex>
  uniform float outlineThickness;
  void main() {
    #include <begin_vertex>
    #include <beginnormal_vertex>
    #include <morphinstance_vertex>
    #include <morphtarget_vertex>
    #include <morphnormal_vertex>
    #include <skinbase_vertex>
    #include <skinnormal_vertex>
    #include <skinning_vertex>
    transformed += normalize(objectNormal) * outlineThickness;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(transformed, 1.0);
  }
`;

const OUTLINE_FRAGMENT_SHADER = `
  uniform vec3 outlineColor;
  void main() {
    gl_FragColor = vec4(outlineColor, 1.0);
  }
`;

// Single place to tune the outline: this is the WORLD-space thickness (in
// the same units as the avatar's overall height), independent of any given
// mesh node's local scale. Per-mesh nodes in this rig have wildly different
// local scales (e.g. the body node is ~2.54, the hair node is ~8.9), and the
// shader offset is applied in local space, so without compensation the same
// constant produced a near-invisible outline on the body and an oversized/
// broken one on the hair. Dividing by each mesh's world scale up front makes
// every mesh converge on the same final on-screen thickness.
const OUTLINE_WORLD_THICKNESS_RATIO = 0.0006; // fraction of avatar height
const OUTLINE_COLOR = 0x0d0d0d;

function addOutlines(root, avatarHeight) {
  root.updateMatrixWorld(true);

  const worldThickness = avatarHeight * OUTLINE_WORLD_THICKNESS_RATIO;
  const outlineMeshes = [];

  // Snapshot the mesh list before adding anything: mutating the scene graph
  // (obj.add) while root.traverse is still walking it would visit the newly
  // added outline meshes too, recursing forever (outline-of-an-outline, ...).
  const meshes = [];
  root.traverse((obj) => {
    if (obj.isMesh && obj.geometry.attributes.normal && obj.material.visible !== false) {
      meshes.push(obj);
    }
  });

  meshes.forEach((obj) => {
    const worldScale = obj.getWorldScale(new THREE.Vector3());
    const avgScale = (worldScale.x + worldScale.y + worldScale.z) / 3;
    const localThickness = worldThickness / (avgScale || 1);

    const outlineMaterial = new THREE.ShaderMaterial({
      uniforms: {
        outlineThickness: { value: localThickness },
        outlineColor: { value: new THREE.Color(OUTLINE_COLOR) },
      },
      vertexShader: OUTLINE_VERTEX_SHADER,
      fragmentShader: OUTLINE_FRAGMENT_SHADER,
      side: THREE.BackSide,
    });

    const outlineMesh = obj.isSkinnedMesh
      ? new THREE.SkinnedMesh(obj.geometry, outlineMaterial)
      : new THREE.Mesh(obj.geometry, outlineMaterial);

    if (obj.isSkinnedMesh) {
      outlineMesh.bind(obj.skeleton, obj.bindMatrix);
    }

    // The renderer reads morph influences off the object being drawn, not the
    // geometry, so the outline mesh needs its own copy of the source mesh's
    // morph state (this rig ships default weights baked in, e.g. hideGoggles
    // at 1.0 — see mesh.weights in the glb) or it renders the un-morphed pose.
    if (obj.morphTargetInfluences) {
      outlineMesh.morphTargetInfluences = obj.morphTargetInfluences;
      outlineMesh.morphTargetDictionary = obj.morphTargetDictionary;
    }

    outlineMesh.renderOrder = 1;
    obj.add(outlineMesh);
    outlineMeshes.push(outlineMesh);
  });

  return outlineMeshes;
}

// Official color palette (source: coolors.co/232323-373534-c2bbb8-5c1a88-ed2793-ffcc3d)
// shown so artists using this viewer as reference material have the exact
// hex values on hand, rather than eyeballing colors off the rendered model.
const COLOR_PALETTE = [
  { hex: '#ED2793', name: 'Magenta' },
  { hex: '#5C1A88', name: 'Purple' },
  { hex: '#373534', name: 'Base Gray' },
  { hex: '#C2BBB8', name: 'Light Gray' },
  { hex: '#232323', name: 'Dark Gray' },
  { hex: '#FFCC3D', name: 'Gold' },
];

function setupColorPalette() {
  const toggleBtn = document.getElementById('palette-toggle-btn');
  const toggleLabel = document.getElementById('palette-toggle-label');
  const panelEl = document.getElementById('palette-panel');
  const swatchesEl = document.getElementById('palette-swatches');
  if (!toggleBtn || !toggleLabel || !panelEl || !swatchesEl) return;

  COLOR_PALETTE.forEach(({ hex, name }) => {
    const swatch = document.createElement('button');
    swatch.className = 'swatch';
    swatch.title = `Copy ${hex}`;

    const colorBox = document.createElement('div');
    colorBox.className = 'swatch-color';
    colorBox.style.background = hex;

    const hexLabel = document.createElement('div');
    hexLabel.className = 'swatch-hex';
    hexLabel.textContent = hex;

    const nameLabel = document.createElement('div');
    nameLabel.className = 'swatch-name';
    nameLabel.textContent = name;

    const labelGroup = document.createElement('div');
    labelGroup.className = 'swatch-label';
    labelGroup.appendChild(hexLabel);
    labelGroup.appendChild(nameLabel);

    swatch.appendChild(colorBox);
    swatch.appendChild(labelGroup);

    swatch.addEventListener('click', async () => {
      await navigator.clipboard.writeText(hex);
      swatch.classList.add('copied');
      const originalText = hexLabel.textContent;
      hexLabel.textContent = 'Copied!';
      setTimeout(() => {
        swatch.classList.remove('copied');
        hexLabel.textContent = originalText;
      }, 1000);
    });

    swatchesEl.appendChild(swatch);
  });

  toggleBtn.addEventListener('click', () => {
    const isOpen = toggleBtn.getAttribute('aria-expanded') === 'true';
    const next = !isOpen;
    toggleBtn.setAttribute('aria-expanded', String(next));
    panelEl.classList.toggle('hidden', !next);
    toggleLabel.textContent = next ? 'Hide color palette' : 'Show color palette';
  });
}

// The shirt is a separate mesh node (not part of Body) and hiding the chest
// fluff underneath it is a blend shape on Body, not a visibility toggle —
// same mechanism Unity uses (hideChestfluff dialed to 100% when the shirt is
// worn). The glb ships with the shirt hidden and hideChestfluff at its
// default ~11% (fluff partly tucked in even bare-chested), so "off" restores
// exactly that baked default rather than assuming a hard 0.
const CLOTHING_ON_CHEST_FLUFF_WEIGHT = 1;

function setupClothingToggle(model) {
  const shirt = model.getObjectByName('shirt');
  const body = model.getObjectByName('Body');
  const toggleEl = document.getElementById('clothing-toggle');
  if (!shirt || !body || !toggleEl) return;

  // "Body" is a Group wrapping one SkinnedMesh per material (Body_1..Body_6,
  // from the multi-material export) — each is a separate object with its own
  // morphTargetInfluences array, even though they all represent the same
  // underlying vertex data. Setting the influence on the Group itself is a
  // no-op; it has to be set on every child mesh that has the target.
  const bodyParts = [];
  body.traverse((o) => {
    if (o.isMesh && o.morphTargetDictionary?.hideChestfluff !== undefined) {
      bodyParts.push(o);
    }
  });

  const chestFluffIndex = bodyParts[0]?.morphTargetDictionary.hideChestfluff;
  const defaultChestFluffWeight =
    chestFluffIndex !== undefined ? bodyParts[0].morphTargetInfluences[chestFluffIndex] : undefined;

  function applyClothingState(showClothing) {
    shirt.visible = showClothing;

    if (chestFluffIndex !== undefined) {
      const weight = showClothing ? CLOTHING_ON_CHEST_FLUFF_WEIGHT : defaultChestFluffWeight;
      bodyParts.forEach((part) => {
        part.morphTargetInfluences[chestFluffIndex] = weight;
      });
    }
  }

  toggleEl.addEventListener('change', () => applyClothingState(toggleEl.checked));
  applyClothingState(toggleEl.checked);
}

// Clip names come straight out of VRCFury's baked animator ("go_asl_is_your_
// cat_friendly", "go_additive_reference_pose") rather than anything a viewer
// should show verbatim — turn the snake_case/prefix mess into a readable label.
function formatPoseName(rawName) {
  return rawName
  // return rawName
  //   .replace(/^go_/, '')
  //   .replace(/_/g, ' ')
  //   .replace(/\b\w/g, (c) => c.toUpperCase());
}

let currentPoseAction = null;

const NO_POSE_VALUE = '-1';

// Dev-only curation mode (?curate=1): instead of trawling a static list of
// ~700 clips with no idea what most of them look like, play each one in the
// actual viewer and click "Keep this pose" to build an in-memory shortlist,
// exported at the end as the newline-separated list extract_animations.py's
// --keep-file expects. Nothing here touches the glb; it's purely a UI aid.
const CURATE_MODE = new URLSearchParams(location.search).get('curate') === '1';
const keptPoseNames = new Set();

function renderKeptList() {
  const countEl = document.getElementById('kept-count');
  const listEl = document.getElementById('kept-list');
  const outputEl = document.getElementById('kept-output');
  if (!countEl || !listEl || !outputEl) return;

  countEl.textContent = String(keptPoseNames.size);
  outputEl.value = [...keptPoseNames].join('\n');

  listEl.innerHTML = '';
  keptPoseNames.forEach((name) => {
    const row = document.createElement('div');
    const label = document.createElement('span');
    label.textContent = name;
    const removeBtn = document.createElement('button');
    removeBtn.textContent = 'Remove';
    removeBtn.addEventListener('click', () => {
      keptPoseNames.delete(name);
      renderKeptList();
      syncKeepButton();
    });
    row.appendChild(label);
    row.appendChild(removeBtn);
    listEl.appendChild(row);
  });
}

function setupPoseSelector(mixer, clips) {
  const poseRow = document.getElementById('pose-row');
  const selectEl = document.getElementById('pose-select');
  const keepBtn = document.getElementById('keep-pose-btn');
  const discardBtn = document.getElementById('discard-pose-btn');
  const curatePanel = document.getElementById('curate-panel');
  if (!poseRow || !selectEl || clips.length === 0) return;

  const noneOption = document.createElement('option');
  noneOption.value = NO_POSE_VALUE;
  noneOption.textContent = 'None';
  selectEl.appendChild(noneOption);

  clips.forEach((clip, i) => {
    const option = document.createElement('option');
    option.value = String(i);
    option.textContent = formatPoseName(clip.name);
    selectEl.appendChild(option);
  });

  function playPose(index) {
    if (index < 0) {
      if (currentPoseAction) {
        currentPoseAction.fadeOut(0.3);
        currentPoseAction = null;
      }
      return;
    }

    const nextAction = mixer.clipAction(clips[index]);
    nextAction.reset();
    nextAction.setLoop(THREE.LoopRepeat);
    nextAction.play();

    if (currentPoseAction && currentPoseAction !== nextAction) {
      currentPoseAction.crossFadeTo(nextAction, 0.3, false);
    }
    currentPoseAction = nextAction;
  }

  selectEl.value = NO_POSE_VALUE;
  selectEl.addEventListener('change', () => playPose(Number(selectEl.value)));

  poseRow.classList.remove('hidden');

  if (CURATE_MODE && keepBtn && discardBtn && curatePanel) {
    keepBtn.classList.remove('hidden');
    discardBtn.classList.remove('hidden');
    curatePanel.classList.remove('hidden');

    // Review flow: both buttons advance to the next clip in the list so you
    // can plow through ~700 entries quickly without touching the dropdown —
    // Keep also records the clip you were just looking at before moving on,
    // Discard just moves on.
    function goToNext() {
      const current = Number(selectEl.value);
      const nextIndex = current < 0 ? 0 : current + 1;
      if (nextIndex >= clips.length) {
        selectEl.value = NO_POSE_VALUE;
        playPose(-1);
        return;
      }
      selectEl.value = String(nextIndex);
      playPose(nextIndex);
    }

    keepBtn.addEventListener('click', () => {
      const current = Number(selectEl.value);
      if (current >= 0) {
        keptPoseNames.add(clips[current].name);
        renderKeptList();
      }
      goToNext();
    });

    discardBtn.addEventListener('click', goToNext);

    renderKeptList();

    document.getElementById('copy-kept-btn')?.addEventListener('click', async () => {
      const outputEl = document.getElementById('kept-output');
      await navigator.clipboard.writeText(outputEl.value);
    });

    // Start the review at the first real clip rather than "None", since the
    // whole point of curate mode is working through the list.
    selectEl.value = '0';
    playPose(0);
  }
}

setupColorPalette();

const dracoLoader = new DRACOLoader();
dracoLoader.setDecoderPath('https://unpkg.com/three@0.165.0/examples/jsm/libs/draco/');

const loader = new GLTFLoader();
loader.setDRACOLoader(dracoLoader);

loader.load(
  MODEL_URL,
  (gltf) => {
    const model = gltf.scene;

    // Center and scale the model to a consistent viewing size regardless
    // of the arbitrary export scale/units coming out of Unity.
    const box = new THREE.Box3().setFromObject(model);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());

    model.position.x -= center.x;
    model.position.z -= center.z;
    model.position.y -= box.min.y;

    makeUnlit(model);

    const height = size.y || 1.8;
    addOutlines(model, height);
    setupClothingToggle(model);

    scene.add(model);

    controls.target.set(0, height * 0.55, 0);
    camera.position.set(0, height * 0.6, height * 1.8);
    controls.update();

    if (gltf.animations && gltf.animations.length) {
      mixer = new THREE.AnimationMixer(model);
      setupPoseSelector(mixer, gltf.animations);
    }

    loadingEl.style.display = 'none';
  },
  (progress) => {
    if (progress.total) {
      const pct = Math.round((progress.loaded / progress.total) * 100);
      loadingEl.textContent = `Loading avatar… ${pct}%`;
    }
  },
  (error) => {
    console.error('Failed to load model:', error);
    loadingEl.textContent = 'Failed to load model — see console for details.';
  }
);

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

function animate() {
  requestAnimationFrame(animate);
  const delta = clock.getDelta();
  if (mixer) mixer.update(delta);
  controls.update();
  renderer.render(scene, camera);
}
animate();
