import { useEffect, useMemo, useRef, useState } from 'react';
import { Activity, Axis3D, CircleDot, Clock3, Eye, EyeOff, Gauge, HelpCircle, KeyRound, Link2, Pause, Play, Plus, RotateCcw, Save, Settings2, Trash2, X } from 'lucide-react';
import type { KinematicGraph, KinematicJoint, KinematicState } from '../../domain/kinematics';
import {
  activeMotionClip,
  buildRigHierarchy,
  createMotionClip,
  deleteMotionClip,
  deleteMotionKeyframe,
  diagnoseAdvancedRig,
  ensureRigControls,
  flattenRigHierarchy,
  frameToSeconds,
  moveMotionKeyframe,
  normalizeAnimationSettings,
  secondsToFrame,
  setActiveMotionClip,
  updateAnimationSettings,
  updateMotionClip,
  updateRigControl,
  upsertPoseKeyframe,
} from '../../application/kinematics/advancedRig';
import { sampleKinematicMotionClip } from '../../application/kinematics/robotMotionController';

type AdvancedRigTab = 'rig' | 'pose' | 'constraints' | 'animation';

type AdvancedRigWorkspaceProps = {
  nodeId: string;
  graph: KinematicGraph;
  state: KinematicState;
  selectedJointId?: string;
  onSelectedJointChange: (jointId: string) => void;
  onGraphChange: (updater: (graph: KinematicGraph) => KinematicGraph, status: string) => void;
  onJointChange: (jointId: string, patch: Partial<KinematicJoint>) => void;
  onJointValueChange: (jointId: string, value: number) => void;
  onJointValuesChange: (values: Record<string, number>) => void;
  onResetPose: () => void;
  onShowJoint: (jointId: string, mode: 'show-joint' | 'pick-origin' | 'axis-gizmo') => void;
  onSave: () => void | Promise<void>;
  tutorialRequest?: number;
};

const jointRange = (joint: KinematicJoint) => {
  if (joint.type === 'fixed') return { min: 0, max: 0, step: 0.01, unit: '' };
  if (joint.type === 'prismatic') return { min: joint.limits?.lower ?? -1, max: joint.limits?.upper ?? 1, step: 0.001, unit: 'm' };
  if (joint.type === 'continuous') return { min: -Math.PI * 2, max: Math.PI * 2, step: 0.01, unit: 'rad' };
  return { min: joint.limits?.lower ?? -Math.PI, max: joint.limits?.upper ?? Math.PI, step: 0.01, unit: 'rad' };
};

const finiteInput = (value: string, fallback: number) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const axisName = (joint: KinematicJoint) => {
  const absolute = joint.axis.map(Math.abs);
  const maximum = Math.max(...absolute);
  const index = absolute.indexOf(maximum);
  const sign = joint.axis[index] < 0 ? '-' : '+';
  return `${sign}${['X', 'Y', 'Z'][index]}`;
};

const formatValue = (value: number, joint: KinematicJoint) =>
  joint.type === 'prismatic' ? `${value.toFixed(3)} m` : `${(value * 180 / Math.PI).toFixed(1)} deg`;

export const AdvancedRigWorkspace = ({
  nodeId,
  graph,
  state,
  selectedJointId,
  onSelectedJointChange,
  onGraphChange,
  onJointChange,
  onJointValueChange,
  onJointValuesChange,
  onResetPose,
  onShowJoint,
  onSave,
  tutorialRequest = 0,
}: AdvancedRigWorkspaceProps) => {
  const [tab, setTab] = useState<AdvancedRigTab>('rig');
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [showTutorial, setShowTutorial] = useState(false);
  const [newClipName, setNewClipName] = useState('Robot Action');
  const playbackStartedAt = useRef(0);
  const playbackOffset = useRef(0);
  const settings = normalizeAnimationSettings(graph.animationSettings);
  const clip = activeMotionClip(graph);
  const selectedJoint = graph.joints.find((joint) => joint.id === selectedJointId) ?? graph.joints[0];
  const hierarchy = useMemo(() => flattenRigHierarchy(buildRigHierarchy(graph)), [graph]);
  const diagnostics = useMemo(() => diagnoseAdvancedRig(graph), [graph]);
  const errors = diagnostics.filter((item) => item.severity === 'error').length;
  const warnings = diagnostics.filter((item) => item.severity === 'warning').length;

  useEffect(() => {
    if (graph.rigControls?.length === graph.joints.filter((joint) => joint.status !== 'rejected').length && graph.animationSettings) return;
    onGraphChange(ensureRigControls, 'Advanced rig controls initialized');
  }, [graph.animationSettings, graph.joints, graph.rigControls?.length, onGraphChange]);

  useEffect(() => {
    if (!playing || !clip) return undefined;
    playbackStartedAt.current = performance.now();
    playbackOffset.current = time;
    const timer = window.setInterval(() => {
      const elapsed = playbackOffset.current + (performance.now() - playbackStartedAt.current) / 1000;
      const nextTime = clip.loop ? elapsed % clip.duration : Math.min(elapsed, clip.duration);
      setTime(nextTime);
      onJointValuesChange(sampleKinematicMotionClip(clip, nextTime));
      if (!clip.loop && elapsed >= clip.duration) setPlaying(false);
    }, 33);
    return () => window.clearInterval(timer);
  }, [clip, onJointValuesChange, playing]);

  useEffect(() => {
    if (clip && time > clip.duration) setTime(clip.duration);
  }, [clip, time]);

  useEffect(() => {
    if (tutorialRequest > 0) setShowTutorial(true);
  }, [tutorialRequest]);

  const applyGraph = (updater: (current: KinematicGraph) => KinematicGraph, status: string) => onGraphChange(updater, status);

  const changePose = (joint: KinematicJoint, value: number) => {
    onJointValueChange(joint.id, value);
    if (!settings.autoKey || !clip) return;
    const nextState = { ...state, jointValues: { ...state.jointValues, [joint.id]: value } };
    applyGraph(
      (current) => upsertPoseKeyframe(current, clip.id, time, nextState, { selectedJointId: joint.id, label: `Frame ${secondsToFrame(time, settings.fps)}` }),
      'Pose changed and auto-keyed',
    );
  };

  const createClip = () => {
    applyGraph((current) => createMotionClip(current, newClipName, 4).graph, 'Animation clip created');
  };

  const addKey = (selectedOnly: boolean) => {
    if (!clip) return;
    applyGraph(
      (current) => upsertPoseKeyframe(current, clip.id, time, state, {
        selectedJointId: selectedOnly ? selectedJoint?.id : undefined,
        label: selectedOnly && selectedJoint ? selectedJoint.name : `Pose ${secondsToFrame(time, settings.fps)}`,
      }),
      selectedOnly ? 'Joint keyframe stored' : 'Full pose keyframe stored',
    );
  };

  const scrub = (nextTime: number) => {
    setPlaying(false);
    setTime(nextTime);
    if (clip) onJointValuesChange(sampleKinematicMotionClip(clip, nextTime));
  };

  return (
    <div className="advanced-rig-workspace" aria-label="Advanced mechanical rig workspace">
      <header className="advanced-rig-header">
        <div>
          <strong>Advanced Rig & Animation</strong>
          <span>Hierarchy, local constraints, pose controls and persistent keyframes</span>
        </div>
        <div className="advanced-rig-header-actions">
          <button className="advanced-help-button" title="Open the guided Advanced Rig tutorial" aria-label="Open Advanced Rig tutorial" onClick={() => setShowTutorial(true)}>
            <HelpCircle size={15} /><span>Help</span>
          </button>
          <div className={`advanced-rig-health ${errors ? 'error' : warnings ? 'warning' : 'ok'}`}>
            <Activity size={14} />
            <span>{errors ? `${errors} errors` : warnings ? `${warnings} warnings` : 'Rig valid'}</span>
          </div>
        </div>
      </header>

      {showTutorial && (
        <div className="advanced-tutorial-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && setShowTutorial(false)}>
          <section className="advanced-tutorial" role="dialog" aria-modal="true" aria-labelledby="advanced-tutorial-title">
            <header>
              <div>
                <span className="advanced-tutorial-kicker">Guided mechanical workflow</span>
                <h3 id="advanced-tutorial-title">Advanced Rig tutorial</h3>
                <p>Build and animate a rigid mechanism without modifying its source geometry.</p>
              </div>
              <button className="icon-only" title="Close tutorial" aria-label="Close Advanced Rig tutorial" onClick={() => setShowTutorial(false)}><X size={17} /></button>
            </header>

            <div className="advanced-tutorial-axis" aria-label="Local axis color reference">
              <span><i className="axis-x" />X red</span><span><i className="axis-y" />Y green</span><span><i className="axis-z" />Z blue</span><span><i className="axis-active" />Active axis yellow</span>
            </div>

            <ol className="advanced-tutorial-steps">
              <li><strong>Import and select</strong><span>Load the complete robot and select its root object in Scene. Confirm that all rigid parts remain visible.</span></li>
              <li><strong>Inspect the chain</strong><span>Open Rig. Read from the root downward and verify every parent, joint and child. Select a row to reveal its control in the viewport.</span></li>
              <li><strong>Verify the pivot</strong><span>Open Constraints, press Show and inspect the local frame. Use Pick pivot only when the yellow axis does not cross the real mechanical center.</span></li>
              <li><strong>Correct the axis</strong><span>Use Edit axis and drag the gizmo. Revolute joints rotate around one axis; prismatic joints translate only along one axis.</span></li>
              <li><strong>Define limits</strong><span>Set Lower and Upper before testing. Use radians for rotation and model units for translation. Velocity, damping and friction describe mechanical behavior.</span></li>
              <li><strong>Test in Pose</strong><span>Move one slider at a time and watch the complete downstream chain. Press Home after testing to verify that no drift remains.</span></li>
              <li><strong>Animate</strong><span>Create an Action, choose FPS and interpolation, place the timeline cursor, pose the mechanism and press Key Pose. Enable Loop only after checking the endpoints.</span></li>
              <li><strong>Validate and save</strong><span>Resolve all red diagnostics, review warnings, then press Save Rig. Refresh the application and replay the Action to confirm persistence.</span></li>
            </ol>

            <div className="advanced-tutorial-notes">
              <article><strong>Grippers and coupled parts</strong><span>Choose the driving finger in Mimic driver. Use multiplier -1 for an opposite finger and adjust Offset only when its home position differs.</span></article>
              <article><strong>Non-destructive rule</strong><span>Rig tools update KinematicGraph and pose state. If geometry changes position while merely editing metadata, stop and restore Home before saving.</span></article>
            </div>

            <footer>
              <span>Recommended order: Rig → Constraints → Pose → Animation → Save</span>
              <div>
                {(['rig', 'constraints', 'pose', 'animation'] as AdvancedRigTab[]).map((targetTab) => (
                  <button key={targetTab} onClick={() => { setTab(targetTab); setShowTutorial(false); }}>{targetTab[0].toUpperCase() + targetTab.slice(1)}</button>
                ))}
              </div>
            </footer>
          </section>
        </div>
      )}

      <nav className="advanced-rig-tabs" aria-label="Advanced rig tools">
        <button className={tab === 'rig' ? 'active' : ''} onClick={() => setTab('rig')}><Link2 size={14} /><span>Rig</span></button>
        <button className={tab === 'pose' ? 'active' : ''} onClick={() => setTab('pose')}><CircleDot size={14} /><span>Pose</span></button>
        <button className={tab === 'constraints' ? 'active' : ''} onClick={() => setTab('constraints')}><Gauge size={14} /><span>Constraints</span></button>
        <button className={tab === 'animation' ? 'active' : ''} onClick={() => setTab('animation')}><Clock3 size={14} /><span>Animation</span></button>
      </nav>

      {tab === 'rig' && (
        <div className="advanced-rig-layout">
          <div className="rig-hierarchy" aria-label="Mechanical hierarchy">
            <div className="advanced-subhead"><strong>Mechanical hierarchy</strong><span>{graph.parts.length} parts</span></div>
            {hierarchy.map((item) => (
              <button
                key={item.part.id}
                className={item.incomingJoint?.id === selectedJoint?.id ? 'rig-tree-row selected' : 'rig-tree-row'}
                style={{ paddingLeft: `${8 + item.depth * 16}px` }}
                disabled={!item.incomingJoint}
                onClick={() => item.incomingJoint && onSelectedJointChange(item.incomingJoint.id)}
              >
                <span className="rig-tree-line" />
                <strong>{item.part.name}</strong>
                <small>{item.incomingJoint ? `${item.incomingJoint.type} ${axisName(item.incomingJoint)}` : 'root'}</small>
              </button>
            ))}
          </div>
          <div className="rig-control-editor">
            <div className="advanced-subhead">
              <strong>Viewport controls</strong>
              <button title="Generate controls from every joint" onClick={() => applyGraph(ensureRigControls, 'Rig controls synchronized')}><Plus size={14} /></button>
            </div>
            {(graph.rigControls ?? []).map((control) => {
              const joint = graph.joints.find((item) => item.id === control.jointId);
              return (
                <div className="rig-control-row" key={control.id}>
                  <button className="icon-only" title={control.visible ? 'Hide control' : 'Show control'} onClick={() => applyGraph((current) => updateRigControl(current, control.id, { visible: !control.visible }), 'Rig control visibility changed')}>
                    {control.visible ? <Eye size={14} /> : <EyeOff size={14} />}
                  </button>
                  <button className="rig-control-name" title="Select and reveal this joint" onClick={() => { onSelectedJointChange(control.jointId); onShowJoint(control.jointId, 'show-joint'); }}>
                    <strong>{control.name}</strong><small>{joint?.name ?? control.jointId}</small>
                  </button>
                  <select value={control.shape} onChange={(event) => applyGraph((current) => updateRigControl(current, control.id, { shape: event.target.value as typeof control.shape }), 'Rig control shape changed')}>
                    <option value="ring">Ring</option><option value="axis">Axis</option><option value="slider">Slider</option><option value="sphere">Sphere</option>
                  </select>
                  <input type="color" aria-label={`${control.name} color`} value={control.color} onChange={(event) => applyGraph((current) => updateRigControl(current, control.id, { color: event.target.value }), 'Rig control color changed')} />
                  <input type="number" title="Control display size" min="0.1" max="10" step="0.1" value={control.size} onChange={(event) => applyGraph((current) => updateRigControl(current, control.id, { size: finiteInput(event.target.value, control.size) }), 'Rig control size changed')} />
                </div>
              );
            })}
          </div>
        </div>
      )}

      {tab === 'pose' && (
        <div className="advanced-pose-editor">
          <div className="advanced-toolbar">
            <button title="Return all joints to their persisted Home pose" onClick={onResetPose}><RotateCcw size={14} /><span>Home</span></button>
            <button title="Show the selected pivot and local axis" disabled={!selectedJoint} onClick={() => selectedJoint && onShowJoint(selectedJoint.id, 'show-joint')}><Axis3D size={14} /><span>Show frame</span></button>
            <button title="Store the current pose at the timeline cursor" disabled={!clip} onClick={() => addKey(false)}><KeyRound size={14} /><span>Key pose</span></button>
          </div>
          <div className="advanced-pose-list">
            {graph.joints.filter((joint) => joint.status !== 'rejected').map((joint) => {
              const range = jointRange(joint);
              const value = state.jointValues[joint.id] ?? state.homeJointValues[joint.id] ?? 0;
              return (
                <label key={joint.id} className={joint.id === selectedJoint?.id ? 'advanced-pose-row selected' : 'advanced-pose-row'}>
                  <button title={`Select ${joint.name}`} onClick={() => onSelectedJointChange(joint.id)}><strong>{joint.name}</strong><small>{joint.type} {axisName(joint)}</small></button>
                  <input type="range" min={range.min} max={range.max} step={range.step} disabled={joint.type === 'fixed'} value={value} onChange={(event) => changePose(joint, Number(event.target.value))} />
                  <output>{formatValue(value, joint)}</output>
                  <button className="icon-only" title="Insert a key for this joint" disabled={!clip} onClick={() => { onSelectedJointChange(joint.id); addKey(true); }}><KeyRound size={13} /></button>
                </label>
              );
            })}
          </div>
        </div>
      )}

      {tab === 'constraints' && selectedJoint && (
        <div className="advanced-constraint-editor">
          <div className="advanced-subhead"><strong>{selectedJoint.name}</strong><span>Local joint space</span></div>
          <div className="advanced-toolbar">
            <button onClick={() => onShowJoint(selectedJoint.id, 'show-joint')}><Eye size={14} /><span>Show</span></button>
            <button onClick={() => onShowJoint(selectedJoint.id, 'pick-origin')}><CircleDot size={14} /><span>Pick pivot</span></button>
            <button onClick={() => onShowJoint(selectedJoint.id, 'axis-gizmo')}><Axis3D size={14} /><span>Edit axis</span></button>
          </div>
          <div className="constraint-grid">
            <label><span>Motion</span><select value={selectedJoint.type} onChange={(event) => onJointChange(selectedJoint.id, { type: event.target.value as KinematicJoint['type'] })}><option value="fixed">Fixed</option><option value="revolute">Revolute</option><option value="continuous">Continuous</option><option value="prismatic">Prismatic</option><option value="screw">Screw</option></select></label>
            <label><span>Lower</span><input type="number" step="0.01" value={selectedJoint.limits?.lower ?? ''} onChange={(event) => onJointChange(selectedJoint.id, { limits: { ...selectedJoint.limits, lower: finiteInput(event.target.value, 0) } })} /></label>
            <label><span>Upper</span><input type="number" step="0.01" value={selectedJoint.limits?.upper ?? ''} onChange={(event) => onJointChange(selectedJoint.id, { limits: { ...selectedJoint.limits, upper: finiteInput(event.target.value, 0) } })} /></label>
            <label><span>Velocity</span><input type="number" min="0" step="0.01" value={selectedJoint.limits?.velocity ?? ''} onChange={(event) => onJointChange(selectedJoint.id, { limits: { ...selectedJoint.limits, velocity: Math.max(0, finiteInput(event.target.value, 0)) } })} /></label>
            <label><span>Damping</span><input type="number" min="0" step="0.01" value={selectedJoint.dynamics?.damping ?? ''} onChange={(event) => onJointChange(selectedJoint.id, { dynamics: { ...selectedJoint.dynamics, damping: Math.max(0, finiteInput(event.target.value, 0)) } })} /></label>
            <label><span>Friction</span><input type="number" min="0" step="0.01" value={selectedJoint.dynamics?.friction ?? ''} onChange={(event) => onJointChange(selectedJoint.id, { dynamics: { ...selectedJoint.dynamics, friction: Math.max(0, finiteInput(event.target.value, 0)) } })} /></label>
            <label><span>Mimic driver</span><select value={selectedJoint.coupling?.driverJointId ?? ''} onChange={(event) => onJointChange(selectedJoint.id, { coupling: event.target.value ? { driverJointId: event.target.value, multiplier: selectedJoint.coupling?.multiplier ?? 1, offset: selectedJoint.coupling?.offset ?? 0 } : undefined })}><option value="">None</option>{graph.joints.filter((joint) => joint.id !== selectedJoint.id).map((joint) => <option key={joint.id} value={joint.id}>{joint.name}</option>)}</select></label>
            <label><span>Multiplier</span><input type="number" step="0.1" disabled={!selectedJoint.coupling} value={selectedJoint.coupling?.multiplier ?? 1} onChange={(event) => selectedJoint.coupling && onJointChange(selectedJoint.id, { coupling: { ...selectedJoint.coupling, multiplier: finiteInput(event.target.value, 1) } })} /></label>
            <label><span>Offset</span><input type="number" step="0.01" disabled={!selectedJoint.coupling} value={selectedJoint.coupling?.offset ?? 0} onChange={(event) => selectedJoint.coupling && onJointChange(selectedJoint.id, { coupling: { ...selectedJoint.coupling, offset: finiteInput(event.target.value, 0) } })} /></label>
          </div>
          <div className="constraint-axis-readout"><span>Axis</span><code>{selectedJoint.axis.map((value) => value.toFixed(4)).join(' / ')}</code><span>Pivot</span><code>{selectedJoint.origin.position.map((value) => value.toFixed(4)).join(' / ')}</code></div>
          <div className="rig-diagnostics">{diagnostics.slice(0, 8).map((item, index) => <span className={item.severity} key={`${item.code}-${index}`}>{item.message}</span>)}</div>
        </div>
      )}

      {tab === 'animation' && (
        <div className="advanced-animation-editor">
          <div className="animation-settings-row">
            <label><span>Action</span><select value={clip?.id ?? ''} onChange={(event) => applyGraph((current) => setActiveMotionClip(current, event.target.value), 'Active animation changed')}><option value="">No action</option>{(graph.motionClips ?? []).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
            <label><span>FPS</span><input type="number" min="1" max="240" value={settings.fps} onChange={(event) => applyGraph((current) => updateAnimationSettings(current, { fps: finiteInput(event.target.value, 24) }), 'Animation FPS changed')} /></label>
            <label><span>Interpolation</span><select value={settings.interpolation} onChange={(event) => applyGraph((current) => updateAnimationSettings(current, { interpolation: event.target.value as typeof settings.interpolation }), 'Key interpolation changed')}><option value="smooth">Smooth</option><option value="linear">Linear</option><option value="step">Step</option></select></label>
            <label className="auto-key-toggle"><input type="checkbox" checked={settings.autoKey} onChange={(event) => applyGraph((current) => updateAnimationSettings(current, { autoKey: event.target.checked }), event.target.checked ? 'Auto-key enabled' : 'Auto-key disabled')} /><span>Auto Key</span></label>
          </div>

          {!clip && <div className="new-clip-row"><input value={newClipName} onChange={(event) => setNewClipName(event.target.value)} /><button onClick={createClip}><Plus size={14} /><span>Create Action</span></button></div>}
          {clip && (
            <>
              <div className="clip-properties-row">
                <input aria-label="Action name" value={clip.name} onChange={(event) => applyGraph((current) => updateMotionClip(current, clip.id, { name: event.target.value }), 'Animation renamed')} />
                <label><span>Duration</span><input type="number" min="0.1" max="3600" step="0.1" value={clip.duration} onChange={(event) => applyGraph((current) => updateMotionClip(current, clip.id, { duration: finiteInput(event.target.value, clip.duration) }), 'Animation duration changed')} /></label>
                <label className="auto-key-toggle"><input type="checkbox" checked={clip.loop} onChange={(event) => applyGraph((current) => updateMotionClip(current, clip.id, { loop: event.target.checked }), 'Animation loop changed')} /><span>Loop</span></label>
                <button title="Create another action" onClick={createClip}><Plus size={14} /></button>
                <button title="Delete this action" onClick={() => applyGraph((current) => deleteMotionClip(current, clip.id), 'Animation deleted')}><Trash2 size={14} /></button>
              </div>
              <div className="timeline-transport">
                <button title="Jump to start" onClick={() => scrub(0)}><RotateCcw size={14} /></button>
                <button title={playing ? 'Pause animation' : 'Play animation'} onClick={() => setPlaying((current) => !current)}>{playing ? <Pause size={15} /> : <Play size={15} />}</button>
                <button title="Insert current full pose" onClick={() => addKey(false)}><KeyRound size={14} /><span>Key Pose</span></button>
                <label><span>Frame</span><input type="number" min="0" max={secondsToFrame(clip.duration, settings.fps)} value={secondsToFrame(time, settings.fps)} onChange={(event) => scrub(frameToSeconds(finiteInput(event.target.value, 0), settings.fps))} /></label>
                <output>{time.toFixed(2)} / {clip.duration.toFixed(2)} s</output>
              </div>
              <div className="rig-timeline" aria-label="Animation timeline">
                <input type="range" min="0" max={clip.duration} step={1 / settings.fps} value={time} onChange={(event) => scrub(Number(event.target.value))} />
                <div className="timeline-key-track">
                  {clip.keyframes.map((keyframe, index) => <button key={`${keyframe.time}-${index}`} title={`${keyframe.label ?? 'Key'} at frame ${secondsToFrame(keyframe.time, settings.fps)}`} style={{ left: `${clip.duration ? keyframe.time / clip.duration * 100 : 0}%` }} onClick={() => scrub(keyframe.time)} />)}
                </div>
              </div>
              <div className="keyframe-table">
                {clip.keyframes.map((keyframe, index) => (
                  <div key={`${keyframe.time}-${index}`} className="keyframe-row">
                    <KeyRound size={13} />
                    <input aria-label={`Keyframe ${index + 1} label`} value={keyframe.label ?? ''} readOnly />
                    <label><span>Frame</span><input type="number" min="0" max={secondsToFrame(clip.duration, settings.fps)} value={secondsToFrame(keyframe.time, settings.fps)} onChange={(event) => applyGraph((current) => moveMotionKeyframe(current, clip.id, index, frameToSeconds(finiteInput(event.target.value, 0), settings.fps)), 'Keyframe moved')} /></label>
                    <span>{Object.keys(keyframe.jointValues).length} channels</span>
                    <span>{keyframe.interpolation ?? 'smooth'}</span>
                    <button title="Delete keyframe" onClick={() => applyGraph((current) => deleteMotionKeyframe(current, clip.id, index), 'Keyframe deleted')}><Trash2 size={13} /></button>
                  </div>
                ))}
                {!clip.keyframes.length && <div className="advanced-empty">Pose the mechanism, move the timeline cursor and insert a key pose.</div>}
              </div>
            </>
          )}
          <footer className="advanced-rig-footer">
            <span>Node {nodeId}</span><span>{clip?.keyframes.length ?? 0} keys</span><span>{settings.fps} FPS</span>
            <button title="Persist rig controls, constraints and animation in the project" onClick={() => void onSave()}><Save size={14} /><span>Save Rig</span></button>
          </footer>
        </div>
      )}
    </div>
  );
};
