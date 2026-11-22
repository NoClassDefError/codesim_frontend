import * as vscode from 'vscode';

/**
 * Editor support for CodeSim `.cir` netlists (language `codesim-spice`):
 * the template written by "CodeSim: New Netlist System" and basic completion.
 * The netlist format is defined by codesimpy (core/netlist_system.py).
 */

export const netlistLanguageId = 'codesim-spice';

/** A runnable starting point: a GFL converter on an infinite bus through an RL line. `${title}` is replaced. */
export const netlistTemplate = `\${title}
* CodeSim netlist. Line 1 is the title (the system label in CodeSim).
* Cards follow SPICE: * comments, ; inline comments, + continues the previous card.
* Values take engineering suffixes (k, meg, m, u, n, ...); {expr} is an expression.

* System base (VA, line-line V, Hz). units=pu: R, L, C values are per unit on this base.
.options sbase=1meg vbase=20k freq=50 units=pu method=dop853 reltol=1e-3 abstol=1e-5

* Parameters: editable in the CodeSim parameter panel.
.param SCR=2 rho=0.25 Pref=1 Qref=-0.1
+ faultStart_s=0.3 faultComplete_s=0.301 recoveryStart_s=0.6 recoveryComplete_s=0.601 faultVoltage=0.5

* Infinite bus with a voltage dip (PWL: time value pairs).
Xgrid grid 0 Infbus kA=100
+ Aref=PWL(0 1 {faultStart_s} 1 {faultComplete_s} {faultVoltage} {recoveryStart_s} {faultVoltage} {recoveryComplete_s} 1 1 1)

* Grid impedance from the short-circuit ratio.
Rg grid pcc {rho/(SCR*sqrt(1+rho^2))}
Lg grid pcc {1/(SCR*sqrt(1+rho^2))}

* Terminal capacitor and a grid-following converter at the PCC.
Cpcc pcc 0 0.05
Xgfl pcc 0 GFL_C_F_L KpPll=0.2 KiPll=0.2 Idref={Pref} Iqref={-Qref}

* Run settings: output step, end time.
.tran 0.1m 1

* Optional state-triggered event; {name} of the .meas is its time, usable in PWL knots.
* .meas tran trip WHEN vm(pcc)=0.3 FALL=1 FROM=0.3

* Extra output signals.
.probe tran Vpcc=vm(pcc) Pgfl=par('p(pcc)') Igfl=par('hypot(@xgfl[id], @xgfl[iq])')
.end
`;

interface Model {
	port: 'Voltage' | 'Current';
	parameters: string[];
	references: string[];
	states: string[];
	description: string;
}

/** Built-in codesimpy components (codesimpy.components). User @device models are not known here. */
const models: Record<string, Model> = {
	Infbus: {
		port: 'Voltage', parameters: ['w0', 'kA'], references: ['Aref'], states: ['theta', 'A'],
		description: 'Infinite-bus voltage source',
	},
	Capacitor: {
		port: 'Voltage', parameters: ['C', 'Gd', 'w'], references: [], states: ['vCd', 'vCq', 'thetaC'],
		description: 'Synchronous-frame shunt capacitor (a C card creates one)',
	},
	ZeroCurrent: {
		port: 'Current', parameters: [], references: [], states: [],
		description: 'Empty current port (added automatically)',
	},
	GFM_A_C_LC: {
		port: 'Voltage', parameters: ['C', 'Lf', 'Rv', 'Lv', 'Imax', 'Kp', 'Kp_cc', 'Ki_cc'],
		references: ['Pref', 'Vref', 'wref'],
		states: ['vCd', 'vCq', 'irefd', 'irefq', 'iLd', 'iLq', 'xccd', 'xccq', 'delta', 'theta'],
		description: 'GFM: virtual admittance + current PI, circular current limit, LC filter (voltage port)',
	},
	GFM_A_C_L: {
		port: 'Current', parameters: ['Lf', 'Rv', 'Lv', 'Rg', 'Lg', 'Imax', 'Kp', 'Kp_cc', 'Ki_cc'],
		references: ['Pref', 'Vref', 'wref'],
		states: ['irefd', 'irefq', 'iLd', 'iLq', 'xccd', 'xccq', 'delta', 'theta'],
		description: 'GFM: virtual admittance + current PI, circular current limit, L filter (current port)',
	},
	GFL_C_F_L: {
		port: 'Current',
		parameters: ['L', 'Kicc', 'Kpcc', 'Rg', 'Lg', 'KpPll', 'KiPll', 'wPllMin', 'wPllMax', 'KawPll', 'w0',
			'K1', 'Imax', 'Id2', 'Vth'],
		references: ['Idref', 'Iqref'], states: ['id', 'iq', 'xPIccd', 'xPIccq', 'theta', 'xPLL'],
		description: 'GFL: current references + current PI, PLL, FRT/LVRT current priority, L filter',
	},
	SG: {
		port: 'Current',
		parameters: ['Rs', 'Xl', 'Xad', 'Xaq', 'Xfd', 'Xf1d', 'X1d', 'X1q', 'Rfd', 'R1d', 'R1q', 'Rsnub',
			'Csnub', 'w0', 'Kq', 'Ka', 'Ta', 'Vf0', 'D', 'M', 'Kg'],
		references: ['Pref', 'Vdref', 'Vqref', 'wref'],
		states: ['psi_d', 'psi_kd', 'psi_fd', 'psi_q', 'psi_kq1', 'vr', 'theta', 'w'],
		description: 'Eighth-order synchronous generator with AVR and governor',
	},
};

const cards: [string, string, string][] = [
	['.options', '.options sbase=${1:1meg} vbase=${2:20k} freq=${3:50} units=${4|pu,si|}', 'System base, units and solver options'],
	['.param', '.param ${1:name}=${2:value}', 'Parameters (editable in CodeSim)'],
	['.tran', '.tran ${1:0.1m} ${2:1}', 'Output step and end time: tstep tstop [tstart [tmax]]'],
	['.meas', '.meas tran ${1:event} WHEN ${2:expr}=${3:0} ${4|RISE,FALL,CROSS|}=1 FROM=${5:0}', 'State-triggered event'],
	['.probe', '.probe tran ${1:name}=par(\'${2:expr}\')', 'Extra output signals'],
	['.include', '.include ${1:file.cir}', 'Insert another netlist file'],
	['.hdl', '.hdl ${1:devices.py}', 'Import a Python file with @device models'],
	['.title', '.title ${1:title}', 'Title (overrides line 1)'],
	['.end', '.end', 'End of netlist'],
];

const elements: [string, string, string][] = [
	['R', 'R${1:name} ${2:n1} ${3:n2} ${4:value}', 'Resistor (series branch)'],
	['L', 'L${1:name} ${2:n1} ${3:n2} ${4:value}', 'Inductor (series branch)'],
	['C', 'C${1:name} ${2:node} 0 ${3:value}', 'Shunt capacitor to ground'],
	['X', 'X${1:name} ${2:node} 0 ${3:Model}', 'Device instance'],
];

const options: [string, string, string][] = [
	['sbase', 'sbase=${1:1meg}', 'System base power (VA)'],
	['vbase', 'vbase=${1:20k}', 'System base voltage (line-line V)'],
	['freq', 'freq=${1:50}', 'Base frequency (Hz)'],
	['units', 'units=${1|pu,si|}', 'Unit of R, L, C values'],
	['method', 'method=${1|dop853,rk45,rk23,radau,bdf,lsoda|}', 'Integration method'],
	['reltol', 'reltol=${1:1e-3}', 'Relative tolerance'],
	['abstol', 'abstol=${1:1e-5}', 'Absolute tolerance'],
	['residualtol', 'residualtol=${1:1e-4}', 'Initialization residual tolerance'],
];

const functions: [string, string, string][] = [
	['vm', 'vm(${1:node})', 'Bus voltage magnitude'],
	['vp', 'vp(${1:node})', 'Bus voltage phase (rad, relative to the reference bus)'],
	['v', 'v(${1:node})', 'Bus voltage, alpha axis'],
	['p', 'p(${1:node})', 'Bus active-power injection'],
	['q', 'q(${1:node})', 'Bus reactive-power injection'],
	['i', 'i(${1:Lname})', 'Branch current, alpha axis'],
	['im', 'im(${1:Lname})', 'Branch current magnitude'],
	['wrap', 'wrap(${1:angle})', 'Angle wrapped to (-pi, pi]'],
	['par', 'par(\'${1:expr}\')', 'Expression output'],
	['PWL', 'PWL(${1:0} ${2:1} ${3:t} ${4:v})', 'Piecewise-linear waveform (time value pairs)'],
	...['sqrt', 'exp', 'log', 'log10', 'sin', 'cos', 'tan', 'atan', 'atan2', 'abs', 'min', 'max', 'pow', 'hypot']
		.map((name): [string, string, string] => [name, `${name}(\${1})`, 'Math function']),
];

export const netlistCompletionProvider: vscode.CompletionItemProvider = {
	provideCompletionItems(document, position) {
		const line = document.lineAt(position.line).text;
		const before = line.slice(0, position.character);
		if (position.line === 0 || /^\s*\*/.test(before) || /;/.test(before)) {
			return undefined; // title line and comments
		}
		const text = document.getText();
		const items: vscode.CompletionItem[] = [];
		const add = (label: string, kind: vscode.CompletionItemKind, insert: string, detail: string, sort = '1') => {
			const item = new vscode.CompletionItem(label, kind);
			item.insertText = new vscode.SnippetString(insert);
			item.detail = detail;
			item.sortText = `${sort}${label}`;
			items.push(item);
		};

		// The card this line belongs to: walk up over '+' continuation lines.
		let headLine = position.line;
		while (headLine > 0 && /^\s*\+/.test(document.lineAt(headLine).text)) {
			headLine -= 1;
		}
		const head = (headLine === position.line ? before : document.lineAt(headLine).text).trim();
		const card = head.split(/\s+/)[0]?.toLowerCase() ?? '';

		// Instances in the document, for @xname[state].
		const instances = new Map<string, string>();
		for (const match of text.matchAll(/^\s*(X\w*)\s+\S+\s+\S+\s+([\w.]+)/gim)) {
			instances.set(match[1].toLowerCase(), match[2]);
		}
		const stateMatch = /@(\w+)\[\w*$/.exec(before);
		if (stateMatch) {
			const model = Object.entries(models)
				.find(([name]) => name.toLowerCase() === instances.get(stateMatch[1].toLowerCase())?.toLowerCase())?.[1];
			for (const state of model?.states ?? []) {
				add(state, vscode.CompletionItemKind.Field, `${state}]`, `State of ${stateMatch[1]}`);
			}
			return items;
		}
		if (/@\w*$/.test(before)) {
			for (const [name, model] of instances) {
				add(name, vscode.CompletionItemKind.Variable, `${name}[`, `${model} instance`);
			}
			return items;
		}

		// First word of a card: dot cards and element snippets.
		if (/^\s*\.?\w*$/.test(before) && headLine === position.line) {
			for (const [label, insert, detail] of cards) {
				const item = new vscode.CompletionItem(label, vscode.CompletionItemKind.Keyword);
				item.insertText = new vscode.SnippetString(before.trimStart().startsWith('.') ? insert.slice(1) : insert);
				item.detail = detail;
				items.push(item);
			}
			if (!before.trimStart().startsWith('.')) {
				for (const [label, insert, detail] of elements) {
					add(label, vscode.CompletionItemKind.Snippet, insert, detail, '0');
				}
			}
			return items;
		}

		// Node names already used in the document.
		const nodes = new Set<string>();
		for (const match of text.matchAll(/^\s*[RLCX]\w*\s+(\S+)\s+(\S+)/gim)) {
			nodes.add(match[1]);
			nodes.add(match[2]);
		}
		const words = before.trimStart().split(/\s+/);
		const elementLetter = card[0];
		if (headLine === position.line && ['r', 'l', 'c', 'x'].includes(elementLetter) && !card.startsWith('.')
			&& (words.length === 2 || words.length === 3)) {
			for (const node of nodes) {
				add(node, vscode.CompletionItemKind.Reference, node, 'Node', node === '0' ? '0' : '1');
			}
			return items;
		}
		if (headLine === position.line && elementLetter === 'x' && words.length === 4) {
			for (const [name, model] of Object.entries(models)) {
				add(name, vscode.CompletionItemKind.Class, name, `${model.port} port · ${model.description}`);
			}
			return items;
		}

		// Inside {expr}, '...' or an expression card: functions, parameters, constants.
		const opened = (before.match(/\{/g)?.length ?? 0) > (before.match(/\}/g)?.length ?? 0);
		const quoted = (before.match(/'/g)?.length ?? 0) % 2 === 1;
		const afterValue = /=\s*[^\s=]*$/.test(before);
		if (opened || quoted || (['.meas', '.measure'].includes(card) && /when/i.test(before))) {
			for (const [label, insert, detail] of functions) {
				add(label, vscode.CompletionItemKind.Function, insert, detail);
			}
			for (const match of text.matchAll(/^\s*(?:\.param\b|\+)(.*)$/gim)) {
				for (const parameter of match[1].matchAll(/(\w+)\s*=/g)) {
					add(parameter[1], vscode.CompletionItemKind.Variable, parameter[1], 'Parameter', '0');
				}
			}
			add('pi', vscode.CompletionItemKind.Constant, 'pi', 'Constant');
			add('time', vscode.CompletionItemKind.Constant, 'time', 'Simulation time (s)');
			add('@', vscode.CompletionItemKind.Variable, '@', 'Device state: @xname[state]');
			return items;
		}
		if (afterValue) {
			if (card.startsWith('x')) {
				add('PWL', vscode.CompletionItemKind.Function, 'PWL(${1:0} ${2:1} ${3:t} ${4:v})', 'Piecewise-linear waveform');
			}
			return items;
		}

		if (['.options', '.option', '.opt'].includes(card)) {
			for (const [label, insert, detail] of options) {
				add(label, vscode.CompletionItemKind.Property, insert, detail);
			}
			return items;
		}
		if (['.meas', '.measure'].includes(card)) {
			for (const keyword of ['tran', 'WHEN']) {
				add(keyword, vscode.CompletionItemKind.Keyword, keyword, '.meas keyword');
			}
			for (const keyword of ['RISE', 'FALL', 'CROSS']) {
				add(keyword, vscode.CompletionItemKind.Keyword, `${keyword}=1`, 'Crossing direction (first crossing)');
			}
			add('FROM', vscode.CompletionItemKind.Keyword, 'FROM=${1:0}', 'Detection starts at this time (s)');
			return items;
		}
		if (['.probe', '.save'].includes(card)) {
			add('par', vscode.CompletionItemKind.Function, '${1:name}=par(\'${2:expr}\')', 'Named expression output');
			for (const [label, insert, detail] of functions.slice(0, 7)) {
				add(label, vscode.CompletionItemKind.Function, insert, detail);
			}
			return items;
		}

		// Instance parameters of an X line (on the line itself or a continuation).
		if (card.startsWith('x')) {
			const modelName = document.lineAt(headLine).text.trim().split(/\s+/)[3] ?? '';
			const model = Object.entries(models).find(([name]) => name.toLowerCase() === modelName.toLowerCase())?.[1];
			const cardText = document.getText(new vscode.Range(headLine, 0, position.line, position.character));
			const given = new Set([...cardText.matchAll(/(\w+)\s*=/g)].map((match) => match[1].toLowerCase()));
			for (const reference of model?.references ?? []) {
				if (!given.has(reference.toLowerCase())) {
					add(reference, vscode.CompletionItemKind.Property, `${reference}=\${1}`, 'Reference (required)', '0');
				}
			}
			for (const parameter of model?.parameters ?? []) {
				if (!given.has(parameter.toLowerCase())) {
					add(parameter, vscode.CompletionItemKind.Property, `${parameter}=\${1}`, 'Parameter');
				}
			}
			for (const [base, detail] of [['Sb', 'Device base power (VA)'], ['Vb', 'Device base voltage (V)']]) {
				if (!given.has(base.toLowerCase())) {
					add(base, vscode.CompletionItemKind.Property, `${base}=\${1}`, detail, '2');
				}
			}
			return items;
		}
		return undefined;
	},
};
