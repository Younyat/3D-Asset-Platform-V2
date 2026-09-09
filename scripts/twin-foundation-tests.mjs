import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const command = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const compile = spawnSync(command, ['tsc', '-p', 'tsconfig.twin.json'], { stdio: 'inherit', shell: process.platform === 'win32' });
if (compile.error) console.error(compile.error);
if (compile.status !== 0) process.exit(compile.status ?? 1);

fs.mkdirSync(path.resolve('.tmp/twin-tests'), { recursive: true });
fs.writeFileSync(path.resolve('.tmp/twin-tests/package.json'), '{"type":"commonjs"}\n');

const testModule = path.resolve('.tmp/twin-tests/application/twin/twinFoundation.test.js');
const { runTwinFoundationTests } = await import(pathToFileURL(testModule).href);
const runtimeTestModule = path.resolve('.tmp/twin-tests/application/twin/twinRuntime.test.js');
const { runTwinRuntimeTests } = await import(pathToFileURL(runtimeTestModule).href);
const { createTwinProjectFromAssetDocument, validateTwinProject } = await import(pathToFileURL(path.resolve('.tmp/twin-tests/application/twin/twinFoundation.js')).href);
const { createIndustrialSceneModelNode } = await import(pathToFileURL(path.resolve('.tmp/twin-tests/application/industrialScene/industrialScenePack.js')).href);

runTwinFoundationTests();
runTwinRuntimeTests();

const realGlbPath = path.resolve('3d imported models/celda_robotica/industrial-arm-6dof.glb');
assert(fs.existsSync(realGlbPath), `Real GLB missing for Twin P0 validation: ${realGlbPath}`);
const realGlb = fs.readFileSync(realGlbPath);
assert(realGlb.subarray(0, 4).toString('utf8') === 'glTF', `Twin P0 real asset test expected a valid GLB: ${realGlbPath}`);
assert(realGlb.length > 100000, `Twin P0 real asset test expected the physical model, not a tiny placeholder: ${realGlbPath}`);

const productNode = createIndustrialSceneModelNode('industrial-gantry-5axis');
const productGraphBefore = JSON.stringify(productNode.geometry.kinematicGraph);
const realAssetDataUrl = `data:model/gltf-binary;base64,${realGlb.toString('base64')}`;
const document = {
  schemaVersion: 1,
  metadata: {
    id: 'real-industrial-twin-project',
    name: 'Real Industrial Twin Project',
    author: 'validation',
    createdAt: '2026-09-06T00:00:00.000Z',
    updatedAt: '2026-09-06T00:00:00.000Z',
  },
  nodes: [
    {
      ...productNode,
      id: 'real-industrial-arm-node',
      name: 'Industrial Arm 6DOF GLB',
      geometry: {
        kind: 'imported-model',
        assetName: 'industrial-arm-6dof.glb',
        assetDataUrl: realAssetDataUrl,
        sourceFormat: 'glb',
        importScale: 1,
        importOffset: [0, 0, 0],
        originalBounds: [1, 1, 1],
        normalizedBounds: [1, 1, 1],
        bones: [],
        animations: [],
        joints: [],
        kinematicGraph: productNode.geometry.kinematicGraph,
        kinematicState: productNode.geometry.kinematicState,
      },
    },
  ],
};

const project = createTwinProjectFromAssetDocument(document, { timestampUtc: '2026-09-06T12:30:00.000Z', includeSimulatedBindings: true });
const errors = validateTwinProject(project).filter((issue) => issue.severity === 'error');
assert(errors.length === 0, `Twin P0 real asset validation failed: ${errors.map((issue) => issue.code).join(', ')}`);
assert(project.assets.length === 1, 'Twin P0 real asset test did not create exactly one TwinAsset.');
assert(project.assets[0].geometryRef.uri === 'industrial-arm-6dof.glb', 'Twin P0 real asset test did not reference the real GLB asset name.');
assert(project.assets[0].kinematicGraphRef === 'real-industrial-arm-node/kinematicGraph', 'Twin P0 real asset test did not keep KinematicGraph as an external reference.');
assert(project.signals.length === productNode.geometry.kinematicGraph.joints.length * 3, 'Twin P0 real asset test did not create the expected joint signals.');
assert(JSON.stringify(productNode.geometry.kinematicGraph) === productGraphBefore, 'Twin P0 real asset test mutated the product KinematicGraph.');
assert(document.nodes[0].geometry.assetDataUrl.length === realAssetDataUrl.length, 'Twin P0 real asset test mutated the real GLB data URL.');

console.log(`Twin P0 real asset test passed: ${path.basename(realGlbPath)}, ${project.signals.length} signals.`);
