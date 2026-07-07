# avatarweb

Three.js viewer for a VRChat avatar (Novabeast), exported from Unity via UnityGLTF to `assets/novabeast.glb`. Static site — `index.html` + `main.js`, no build step, deploys to GitHub Pages via `.github/workflows/deploy.yml` (Git LFS-tracked glb, resolved during the Pages build).

## Never commit the animation clip library

`animations/*.json` and `animations.json` (output of `tools/extract_animations.py`) must **never** be committed or pushed. Some of the poses in this library come from purchased asset packs (e.g. GoGoLoco), and the raw extracted keyframe data is effectively redistributing that paid content. Both are gitignored — keep it that way.

This does **not** apply to `assets/novabeast.glb` itself: baked keyframe data inside the shipped glb (the compiled/final asset the site actually loads) is fine to publish, same as any other baked avatar animation. The line is: standalone extractable pose data = private; baked-into-the-final-model data = public.

## Animation pose workflow

Poses are decoupled from visual re-exports so iterating on the avatar's mesh/materials in Unity doesn't require re-authoring animations every time:

1. Export a glb from Unity with your poses baked in (Animator's controller must have each pose as a plain top-level state — see below).
2. Curate which clips are worth keeping: `./dev.sh` then visit `index.html?curate=1` — plays each clip live on the avatar with **Keep & next** / **Discard & next** buttons, builds a list you copy out.
3. Paste that list into `poses.txt` (gitignored).
4. Extract: `python3 tools/extract_animations.py assets/novabeast.glb animations/ --keep-file poses.txt` — writes one `animations/<name>.json` per clip. Re-running only touches the files for the names you pass; delete a pose you no longer want with `rm animations/<name>.json`.
5. Iterate on visuals in Unity, re-export (animations don't matter in this export).
6. Merge poses back in: `python3 tools/merge_animations.py <new_visuals_glb> animations/ assets/novabeast.glb`.

Also available: `tools/filter_animations.py` strips a glb down to only named animations in place (no JSON intermediate) — useful for shrinking the live `assets/novabeast.glb` to just the poses you're shipping.

### Why UnityGLTF only exports some clips

UnityGLTF's exporter does not walk `AnimatorController` state machines itself — it delegates entirely to Unity's `AnimationUtility.GetAnimationClips(gameObject)`, which only reliably surfaces clips assigned as a **plain top-level AnimatorState's motion**. It does not recurse into BlendTrees or nested sub-state-machines. Poses driven through a locomotion blend tree (e.g. GoGoLoco's directional dash/movement clips) will not appear in the export no matter which Animator controller is active — to export a specific pose, it needs its own plain state in a (possibly dedicated, minimal) AnimatorController.

### uniqueAnimationNames

Turn on UnityGLTF's **Unique Animation Names** export setting. Without it, multiple clips sharing an exact name (common with face/viseme clips reused across controllers) silently collide in the exported glb — same name, different data, and downstream tooling can only guess which one you meant. With it on, duplicates export as `Name`, `Name (1)`, `Name (2)`, etc.

### Node matching uses full scene path, not bare name

`extract_animations.py`/`merge_animations.py` key animation channels by each target node's full scene path (e.g. `Novabeast_lilToon/clothing/shirt`), not bare name or index. VRCFury's export adds a parallel "menu" preview hierarchy that reuses names like `shirt`/`skeleton`/`clothing` from the real mesh/skeleton tree — bare-name matching silently attaches channels to the wrong node about a third of the time on this rig.

### merge_animations.py always discards the input's existing animations first

If you merge into an already-merged `assets/novabeast.glb` (instead of a fresh visuals-only export), the script strips whatever animations are already baked in before appending the current `animations/` set — otherwise deleting a pose's json file wouldn't actually remove it from the output (it'd survive as a leftover from the previous merge). The output's animation list is always exactly "whatever's in `animations/` right now," never a mix of old-plus-new.

### Hair physics bones can't survive a merge into a re-export

VRCFury auto-generates per-export proxy/constraint bones for hair physics with names like `[VF523] Aidenfur Zinika hair` — the numeric ID is reassigned on every export, so these bone paths never match between two separately-exported glbs. Merging extracted animation data into a freshly re-exported visuals glb will therefore silently drop the hair-bone channels of each clip (expect a "N channel(s) skipped" warning) while the actual body pose (skeleton bones like `hips`/`spine`/`upperarm_l`, which have stable names) merges correctly. This is accepted behavior, not a bug to chase — hair just stays in its normal skinned position instead of following pose-specific hair keyframes.
