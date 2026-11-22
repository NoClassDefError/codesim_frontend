import { useEffect, useRef, useState } from 'react';
import {
  isInsideVsCode,
  loadSystemDescriptor,
  newNetlist,
  onBackendInfo,
  onBackendStatus,
  openSignalsView,
  requestBackendInfo,
  runAnalysis,
  runRMS,
  selectBackendDirectory,
  selectUserWorkspace,
  startBackend,
  stopBackend,
  stopSimulation,
} from '../bridge/vscode';
import type { PowerFlowDescriptor, RMSSimulationDescriptor } from '../model/types';

/** Algebraic residual (inf-norm) above which the RMS solve is flagged. */
const rmsResidualWarning = 1e-6;

function formatSeconds(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) {
    return '—';
  }
  return value < 1 ? `${(value * 1e3).toFixed(0)} ms` : `${value.toFixed(2)} s`;
}

function parsePositive(text: string): number | undefined {
  const value = Number(text);
  return text.trim() !== '' && Number.isFinite(value) && value > 0 ? value : undefined;
}

interface Props {
  systemName: string;
  onResetLayout?: () => void;
  onSaveLayout?: () => void;
  showSignalsButton?: boolean;
  view?: 'topology' | 'signals';
  /** Latest RMS run, summarised in the RMS options popover. */
  rmsResult?: RMSSimulationDescriptor;
  /** Power-flow solution drawn on the topology; the toggle shows when present. */
  powerFlow?: PowerFlowDescriptor;
  showPowerFlow?: boolean;
  onTogglePowerFlow?: () => void;
  /** System panel (left) and inspector (right): shown, and their toggles. */
  treeOpen?: boolean;
  onToggleTree?: () => void;
  inspectorOpen?: boolean;
  onToggleInspector?: () => void;
}

export function Toolbar({
  systemName,
  onResetLayout,
  onSaveLayout,
  showSignalsButton = false,
  view = 'topology',
  rmsResult,
  powerFlow,
  showPowerFlow = false,
  onTogglePowerFlow,
  treeOpen = true,
  onToggleTree,
  inspectorOpen = true,
  onToggleInspector,
}: Props) {
  const [systems, setSystems] = useState<string[]>([]);
  const [selectedSystem, setSelectedSystem] = useState('SMIB__GFM_A_C_LC');
  const [backendRunning, setBackendRunning] = useState(false);
  const [running, setRunning] = useState(false);
  const [activeAction, setActiveAction] = useState<string>();
  const [userWorkspace, setUserWorkspace] = useState<string>();
  const [workspaceErrors, setWorkspaceErrors] = useState(0);
  const [backendDirectory, setBackendDirectory] = useState<string>();
  const [rmsCorrection, setRmsCorrection] = useState(rmsResult?.model === 'RMS+Delta');
  const [rmsCutoffText, setRmsCutoffText] = useState(String(rmsResult?.cutoff_Hz ?? 1000));
  const [rmsMaxStepText, setRmsMaxStepText] = useState('');
  const [rmsOptionsOpen, setRmsOptionsOpen] = useState(false);
  const rmsGroupRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!rmsOptionsOpen) {
      return undefined;
    }
    const closeOutside = (event: PointerEvent) => {
      if (!rmsGroupRef.current?.contains(event.target as Node)) {
        setRmsOptionsOpen(false);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setRmsOptionsOpen(false);
      }
    };
    document.addEventListener('pointerdown', closeOutside);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOutside);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [rmsOptionsOpen]);

  useEffect(() => {
    const unsubscribeInfo = onBackendInfo((info) => {
      setSystems(info.systems);
      setSelectedSystem(info.systems.includes(info.selectedSystem)
        ? info.selectedSystem
        : info.systems[0] ?? '');
      setBackendRunning(info.backendRunning);
      setRunning(info.running);
      setUserWorkspace(info.userWorkspace);
      setWorkspaceErrors(info.workspaceErrors ?? 0);
      setBackendDirectory(info.backendDirectory);
    });
    const unsubscribeStatus = onBackendStatus((status) => {
      if (status.backendRunning !== undefined) {
        setBackendRunning(status.backendRunning);
        if (!status.backendRunning) {
          setSystems([]);
        }
      }
      setRunning(status.running);
      setActiveAction(status.running ? status.action : undefined);
      if (status.selectedSystem) {
        setSelectedSystem(status.selectedSystem);
      }
    });
    requestBackendInfo();
    return () => {
      unsubscribeInfo();
      unsubscribeStatus();
    };
  }, []);

  const modelUnavailable = !backendRunning || running || systems.length === 0 || !selectedSystem;
  const selectSystem = (system: string) => {
    setSelectedSystem(system);
    loadSystemDescriptor(system);
  };
  const runLabel = (label: string, action: string) =>
    running && activeAction === action ? `${label}…` : label;
  const rmsCutoff_Hz = parsePositive(rmsCutoffText);
  const rmsMaxStep_ms = parsePositive(rmsMaxStepText);
  const rmsInputsValid = (!rmsCorrection || rmsCutoff_Hz !== undefined)
    && (rmsMaxStepText.trim() === '' || rmsMaxStep_ms !== undefined);
  const startRMS = () => {
    setRmsOptionsOpen(false);
    runRMS(selectedSystem, {
      correction: rmsCorrection,
      cutoff_Hz: rmsCorrection ? rmsCutoff_Hz : undefined,
      maxStep_s: rmsMaxStep_ms !== undefined ? rmsMaxStep_ms / 1e3 : undefined,
    });
  };

  return (
    <header className={`toolbar toolbar-${view}`}>
      <div className="toolbar-title">
        <strong>CodeSim</strong>
        <span>{systemName}</span>
      </div>
      <div className="toolbar-actions">
        {!isInsideVsCode() && <span className="dev-badge">Browser preview</span>}
        {view === 'topology' && (
          <button
            type="button"
            className={backendRunning ? 'toolbar-icon-button backend-toggle active' : 'toolbar-icon-button backend-toggle'}
            onClick={backendRunning ? stopBackend : startBackend}
            title={backendRunning ? 'Stop Python backend' : 'Start Python backend'}
            aria-label={backendRunning ? 'Stop Python backend' : 'Start Python backend'}
            aria-pressed={backendRunning}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M12 2.5v9M6.2 5.8a8 8 0 1 0 11.6 0" />
            </svg>
            <i />
          </button>
        )}
        {view === 'topology' && isInsideVsCode() && (
          <button
            type="button"
            className={backendDirectory ? 'backend-dir-button' : 'backend-dir-button unset'}
            onClick={selectBackendDirectory}
            title={(backendDirectory
              ? `Backend directory: ${backendDirectory}`
              : 'No backend directory found (an installed codesimpy package is used if available)')
              + '\nClick to choose the installed package or another directory'}
            aria-label={backendDirectory
              ? `Backend ${backendDirectory}, click to change`
              : 'Choose the backend'}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M3 6.5A1.5 1.5 0 0 1 4.5 5H9l2 2.5h8.5A1.5 1.5 0 0 1 21 9v9.5a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5v-12Z" />
              <path d="m10 11-2 2 2 2M14 11l2 2-2 2" />
            </svg>
            <span><bdi>{backendDirectory ?? 'Select backend…'}</bdi></span>
          </button>
        )}
        {view === 'topology' && isInsideVsCode() && (
          <button
            type="button"
            className={'backend-dir-button workspace-button'
              + (userWorkspace ? '' : ' unset')
              + (workspaceErrors > 0 ? ' has-errors' : '')}
            onClick={selectUserWorkspace}
            title={(userWorkspace
              ? `User systems folder: ${userWorkspace}`
              : 'No user systems folder (open a folder or click to choose one)')
              + (workspaceErrors > 0 ? ` · ${workspaceErrors} file(s) failed to load, see the CodeSim output` : '')
              + '\nClick to choose another folder'}
            aria-label={userWorkspace
              ? `User systems folder ${userWorkspace}, click to change`
              : 'Choose the folder with user-defined systems'}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M3 6.5A1.5 1.5 0 0 1 4.5 5H9l2 2.5h8.5A1.5 1.5 0 0 1 21 9v9.5a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5v-12Z" />
            </svg>
            <span><bdi>{userWorkspace ?? 'Select folder…'}</bdi></span>
            {workspaceErrors > 0 && <i />}
          </button>
        )}
        {view === 'topology' && isInsideVsCode() && (
          <button
            type="button"
            className="toolbar-icon-button"
            onClick={newNetlist}
            disabled={!userWorkspace}
            title={userWorkspace
              ? `New netlist system (.cir) in ${userWorkspace}`
              : 'New netlist system: select a user systems folder first'}
            aria-label="New netlist system"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M14 3H6.5A1.5 1.5 0 0 0 5 4.5v15A1.5 1.5 0 0 0 6.5 21h11a1.5 1.5 0 0 0 1.5-1.5V8l-5-5Z" />
              <path d="M14 3v5h5M12 11v6M9 14h6" />
            </svg>
          </button>
        )}
        <select
          aria-label="System class"
          value={selectedSystem}
          disabled={!backendRunning || running || systems.length === 0}
          onChange={(event) => selectSystem(event.target.value)}
          title="Select and load a system"
        >
          {systems.length === 0 && <option value="">No systems found</option>}
          {systems.map((name) => <option key={name} value={name}>{name}</option>)}
        </select>
        {view === 'signals' && (
          <div className="toolbar-analysis-actions">
            <button
              type="button"
              className="toolbar-analysis-button primary"
              disabled={modelUnavailable}
              onClick={() => runAnalysis('simulation', selectedSystem)}
              title="Run the EMT time-domain simulation"
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="m8 5 11 7-11 7V5Z" />
              </svg>
              {runLabel('EMT', 'simulation')}
            </button>
            <div className="toolbar-split-button" ref={rmsGroupRef}>
              <button
                type="button"
                className="toolbar-analysis-button primary"
                disabled={modelUnavailable || !rmsInputsValid}
                onClick={startRMS}
                title={rmsCorrection
                  ? `Run the RMS (phasor) simulation with the RMS+Δ correction (cutoff ${rmsCutoffText} Hz)`
                  : 'Run the RMS (phasor) simulation'}
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="m8 5 11 7-11 7V5Z" />
                </svg>
                {runLabel(rmsCorrection ? 'RMS+Δ' : 'RMS', 'rms')}
              </button>
              <button
                type="button"
                className="toolbar-analysis-button primary toolbar-split-toggle"
                disabled={running}
                onClick={() => setRmsOptionsOpen((open) => !open)}
                title="RMS simulation options"
                aria-label="RMS simulation options"
                aria-expanded={rmsOptionsOpen}
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="m7 10 5 5 5-5" />
                </svg>
              </button>
              {rmsOptionsOpen && (
                <div className="toolbar-popover" role="dialog" aria-label="RMS simulation options">
                  <p className="toolbar-popover-note">
                    Phasor model: network and fast filter states are algebraic, only slow
                    dynamics are integrated. Results appear in the Time domain plots.
                  </p>
                  <label className="toolbar-popover-check">
                    <input
                      type="checkbox"
                      checked={rmsCorrection}
                      onChange={(event) => setRmsCorrection(event.target.checked)}
                    />
                    <span>RMS+Δ correction</span>
                  </label>
                  <label>
                    <span>Correction cutoff (Hz)</span>
                    <input
                      type="number"
                      min="1"
                      step="100"
                      value={rmsCutoffText}
                      disabled={!rmsCorrection}
                      onChange={(event) => setRmsCutoffText(event.target.value)}
                    />
                  </label>
                  <label>
                    <span>Max step (ms)</span>
                    <input
                      type="number"
                      min="0"
                      step="0.5"
                      placeholder="1 (default)"
                      value={rmsMaxStepText}
                      onChange={(event) => setRmsMaxStepText(event.target.value)}
                    />
                  </label>
                  {!rmsInputsValid && (
                    <p className="toolbar-popover-error">Enter positive numbers.</p>
                  )}
                  {rmsResult && (
                    <dl className="toolbar-popover-stats">
                      <dt>Last run</dt>
                      <dd>{rmsResult.model === 'RMS+Delta' ? `RMS+Δ · ${rmsResult.cutoff_Hz} Hz` : 'RMS'}</dd>
                      <dt>Wall time</dt>
                      <dd>
                        {formatSeconds(rmsResult.simulationTime_s)}
                        {rmsResult.model === 'RMS+Delta' && ` + ${formatSeconds(rmsResult.correctionTime_s)}`}
                      </dd>
                      <dt>States</dt>
                      <dd title={rmsResult.differentialStateNames.join(', ')}>
                        {rmsResult.differentialStateNames.length} differential · {rmsResult.algebraicStateNames.length} algebraic
                      </dd>
                      <dt>Max residual</dt>
                      <dd className={rmsResult.maxAlgebraicResidual > rmsResidualWarning ? 'warning' : 'ok'}>
                        {rmsResult.maxAlgebraicResidual.toExponential(2)}
                      </dd>
                      {rmsResult.model === 'RMS+Delta' && (
                        <>
                          <dt>Quasi-static modes</dt>
                          <dd>{rmsResult.maxQuasiStaticModeCount ?? 0} (max)</dd>
                        </>
                      )}
                    </dl>
                  )}
                </div>
              )}
            </div>
            {running && (activeAction === 'simulation' || activeAction === 'rms') && (
              <button
                type="button"
                className="toolbar-analysis-button stop"
                onClick={stopSimulation}
                title="Stop the simulation and keep the samples computed so far"
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <rect x="6" y="6" width="12" height="12" rx="1.5" />
                </svg>
                Stop
              </button>
            )}
            <button
              type="button"
              className="toolbar-analysis-button"
              disabled={modelUnavailable}
              onClick={() => runAnalysis('smallSignal', selectedSystem)}
              title="Run the small-signal analysis"
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M3 12h3l2-5 4 10 3-8 2 5h4" />
              </svg>
              {runLabel('Small signal', 'smallSignal')}
            </button>
            <button
              type="button"
              className="toolbar-analysis-button"
              disabled={modelUnavailable}
              onClick={() => runAnalysis('interaction', selectedSystem)}
              title="Run modal interaction analysis (one block per device plus the network)"
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <circle cx="6" cy="7" r="2.5" />
                <circle cx="18" cy="7" r="2.5" />
                <circle cx="12" cy="17" r="2.5" />
                <path d="m8 8.4 2.7 6.2M16 8.4l-2.7 6.2M8.5 7h7" />
              </svg>
              {runLabel('Interaction', 'interaction')}
            </button>
          </div>
        )}
        {showSignalsButton && (
          <button
            type="button"
            className="toolbar-icon-button"
            onClick={openSignalsView}
            title="Open signals and results"
            aria-label="Open signals and results"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M3 12h3l2.2-6 4.1 12 2.5-8 1.8 4H21" />
            </svg>
          </button>
        )}
        {view === 'topology' && (
          <div className="toolbar-button-group">
            <button
              type="button"
              className="toolbar-icon-button"
              disabled={modelUnavailable}
              onClick={() => loadSystemDescriptor(selectedSystem)}
              title="Refresh the selected system"
              aria-label="Refresh the selected system"
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M20 11a8 8 0 0 0-14.9-4M4 4v5h5M4 13a8 8 0 0 0 14.9 4M20 20v-5h-5" />
              </svg>
            </button>
            {powerFlow?.available && onTogglePowerFlow && (
              <button
                type="button"
                className={[
                  'toolbar-icon-button power-flow-toggle',
                  showPowerFlow ? 'active' : '',
                  powerFlow.converged ? '' : 'has-errors',
                ].join(' ').trim()}
                onClick={onTogglePowerFlow}
                title={`${showPowerFlow ? 'Hide' : 'Show'} the power flow`
                  + ` (per unit on ${powerFlow.Sbase} VA)`
                  + (powerFlow.converged ? '' : `\nPower flow did not converge: ${powerFlow.message}`)}
                aria-label="Show or hide the power flow"
                aria-pressed={showPowerFlow}
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M13 3 5 14h6l-1 7 8-11h-6l1-7Z" />
                </svg>
                {!powerFlow.converged && <i />}
              </button>
            )}
            {onToggleTree && (
              <button
                type="button"
                className={treeOpen ? 'toolbar-icon-button active' : 'toolbar-icon-button'}
                onClick={onToggleTree}
                title={`${treeOpen ? 'Hide' : 'Show'} the system panel`}
                aria-label="Show or hide the system panel"
                aria-pressed={treeOpen}
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <rect x="3" y="4" width="18" height="16" rx="1.5" />
                  <path d="M9 4v16" />
                  {treeOpen && <path className="panel-fill" d="M4.5 5.5h3v13h-3z" />}
                </svg>
              </button>
            )}
            {onToggleInspector && (
              <button
                type="button"
                className={inspectorOpen ? 'toolbar-icon-button active' : 'toolbar-icon-button'}
                onClick={onToggleInspector}
                title={`${inspectorOpen ? 'Hide' : 'Show'} the inspector`}
                aria-label="Show or hide the inspector"
                aria-pressed={inspectorOpen}
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <rect x="3" y="4" width="18" height="16" rx="1.5" />
                  <path d="M15 4v16" />
                  {inspectorOpen && <path className="panel-fill" d="M16.5 5.5h3v13h-3z" />}
                </svg>
              </button>
            )}
            {onResetLayout && (
              <button
                type="button"
                className="toolbar-icon-button"
                onClick={onResetLayout}
                title="Automatically arrange the topology"
                aria-label="Automatically arrange the topology"
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <rect x="3" y="4" width="6" height="5" rx="1" />
                  <rect x="15" y="4" width="6" height="5" rx="1" />
                  <rect x="9" y="15" width="6" height="5" rx="1" />
                  <path d="M6 9v3h12V9M12 12v3" />
                </svg>
              </button>
            )}
            {onSaveLayout && isInsideVsCode() && (
              <button
                type="button"
                className="toolbar-icon-button"
                onClick={onSaveLayout}
                title="Save the topology layout"
                aria-label="Save the topology layout"
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M5 3h12l3 3v15H4V3h1Z" />
                  <path d="M8 3v6h8V3M8 21v-7h8v7" />
                </svg>
              </button>
            )}
          </div>
        )}
      </div>
    </header>
  );
}
