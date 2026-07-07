import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';

const MODEL_URL = './assets/novabeast.glb';

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

      const basic = new THREE.MeshBasicMaterial({
        map: mat.map || null,
        color: mat.color ? mat.color.clone() : new THREE.Color(0xffffff),
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

    scene.add(model);

    controls.target.set(0, height * 0.55, 0);
    camera.position.set(0, height * 0.6, height * 1.8);
    controls.update();

    if (gltf.animations && gltf.animations.length) {
      mixer = new THREE.AnimationMixer(model);
      mixer.clipAction(gltf.animations[0]).play();
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
