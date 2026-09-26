/* Align MVP. Local, deterministic migration; no external requests. */
figma.showUI(__html__, { width: 480, height: 680, themeColors: true });

let components = [];
let preview = new Map();
let busy = false;
let scanPageId = null;
const normalize = (value) => String(value || "").trim().toLowerCase().replace(/[\s_-]+/g, " ");
const excluded = new Set(["INSTANCE", "COMPONENT", "COMPONENT_SET"]);
const send = (type, data = {}) => figma.ui.postMessage({ type, ...data });
const errorMessage = (error) => error instanceof Error ? error.message : String(error);

function eligible(node) {
  if (!node || !["FRAME", "GROUP"].includes(node.type)) return false;
  for (let current = node; current && current.type !== "PAGE"; current = current.parent) {
    if (excluded.has(current.type) || current.visible === false || current.locked === true) return false;
  }
  return true;
}

function signature(node) {
  return JSON.stringify({ name: node.name, parent: node.parent && node.parent.id, width: node.width, height: node.height, transform: node.relativeTransform, children: node.children.map(child => child.id) });
}

function pathOf(node) {
  const names = [];
  for (let current = node; current && current.type !== "DOCUMENT"; current = current.parent) names.unshift(current.name);
  return names.join(" / ");
}

function pageNameOf(node) {
  for (let current = node; current; current = current.parent) {
    if (current.type === "PAGE") return current.name;
  }
  return null;
}

async function init() {
  // Components may live on a dedicated design-system page rather than the page being scanned.
  // Index every local component in the file so manual name mapping and Skill scans can reuse
  // definitions across pages. Figma's DocumentNode does not expose a reliable global
  // findAllWithCriteria in all plugin runtimes, so enumerate pages explicitly.
  components = [];
  for (const page of figma.root.children || []) {
    // Dynamic-page documents require an explicit load before reading page children.
    // Without this, findAllWithCriteria throws and the manual UI cannot populate
    // the target-component dropdown.
    if (typeof page.loadAsync === "function") await page.loadAsync();
    const pageComponents = page.findAllWithCriteria({ types: ["COMPONENT"] })
      .filter(node => !node.remote);
    components.push(...pageComponents);
  }
  send("ready", {
    pageName: figma.currentPage.name,
    componentPages: [...new Set(components.map(pageNameOf).filter(Boolean))],
    components: components.map(node => ({
      id: node.id,
      name: node.name,
      path: pathOf(node),
      pageName: pageNameOf(node),
    })),
  });
}

function scan(rules) {
  const validRules = rules.filter(rule => rule.source && components.some(component => component.id === rule.componentId));
  if (!validRules.length) throw new Error("请先添加至少一条有效的名称映射规则。");
  preview.clear();
  scanPageId = figma.currentPage.id;
  const rows = [];
  let visited = 0;
  let protectedCount = 0;
  function visit(node) {
      if (excluded.has(node.type) || node.visible === false || node.locked === true) { protectedCount++; return; }
      if (["FRAME", "GROUP"].includes(node.type)) {
        visited++;
        const matches = validRules.filter(rule => normalize(rule.source) === normalize(node.name));
        const targets = [...new Set(matches.map(rule => rule.componentId))];
        const component = targets.length === 1 ? components.find(item => item.id === targets[0]) : null;
        const row = {
          id: node.id, name: node.name, path: pathOf(node), width: Math.round(node.width), height: Math.round(node.height),
          componentId: component && component.id, componentName: component && component.name,
          status: component ? "matched" : targets.length > 1 ? "ambiguous" : "unmatched",
        };
        rows.push(row);
        if (component) {
          preview.set(node.id, { ...row, signature: signature(node) });
          // A matched outer node owns its subtree; never offer descendants too.
          return;
        }
      }
      visitChildren(node);
  }
  function visitChildren(parent) {
    for (const node of parent.children || []) visit(node);
  }
  const selection = figma.currentPage.selection || [];
  if (selection.length) selection.forEach(visit);
  else visitChildren(figma.currentPage);
  send("scan-result", { rows, pageName: selection.length ? `${figma.currentPage.name} · 当前选区` : figma.currentPage.name, visited, protectedCount });
}

function textNodes(node) {
  return node.findAllWithCriteria({ types: ["TEXT"] });
}

async function copyText(source, instance) {
  const sources = textNodes(source);
  const destinations = textNodes(instance);
  let copied = 0;
  const warnings = [];
  for (const destination of destinations) {
    let candidates = sources.filter(node => normalize(node.name) === normalize(destination.name));
    const uniqueDestination = destinations.filter(node => normalize(node.name) === normalize(destination.name)).length === 1;
    if (!uniqueDestination) candidates = [];
    if (!candidates.length && sources.length === 1 && destinations.length === 1) candidates = sources;
    if (candidates.length !== 1) continue;
    const fonts = destination.fontName === figma.mixed
      ? destination.getRangeAllFontNames(0, destination.characters.length)
      : [destination.fontName];
    if (!fonts.length) throw new Error(`无法确定文本层“${destination.name}”的字体，已保留原图层。`);
    for (const font of fonts) await figma.loadFontAsync(font);
    destination.characters = candidates[0].characters;
    copied++;
  }
  if (copied < sources.length) warnings.push(`${sources.length - copied} 个源文本层未唯一匹配；目标组件保持默认文本。`);
  return { copied, warnings };
}

async function replaceOne(item) {
  const source = await figma.getNodeByIdAsync(item.id);
  const component = await figma.getNodeByIdAsync(item.componentId);
  if (!source || !eligible(source) || !source.parent) throw new Error("原图层已删除、锁定或不再可替换，请重新扫描。");
  if (signature(source) !== item.signature) throw new Error("图层结构或位置已变化，请重新扫描。");
  if (!component || component.type !== "COMPONENT") throw new Error("目标组件已不存在，请刷新组件库。");
  const parent = source.parent;
  if (!("insertChild" in parent)) throw new Error("父级不支持插入组件。");
  const index = parent.children.indexOf(source);
  const transform = source.relativeTransform.map(row => [...row]);
  const size = { width: source.width, height: source.height };
  if (size.width <= 0 || size.height <= 0) throw new Error("零尺寸图层无法安全替换。");
  const instance = component.createInstance();
  try {
    // Keep the new instance off the source parent until async font work completes.
    const text = await copyText(source, instance);
    if (signature(source) !== item.signature) throw new Error("处理期间原图层已变化，请重新扫描。");
    instance.name = source.name;
    instance.resize(size.width, size.height);
    instance.opacity = source.opacity;
    instance.visible = source.visible;
    parent.insertChild(index, instance);
    if ("constraints" in source) instance.constraints = source.constraints;
    if ("layoutPositioning" in source) instance.layoutPositioning = source.layoutPositioning;
    if ("layoutAlign" in source) instance.layoutAlign = source.layoutAlign;
    if ("layoutGrow" in source) instance.layoutGrow = source.layoutGrow;
    instance.relativeTransform = transform;
    // The final mutation removes the original only once all other work succeeds.
    source.remove();
    return { newNodeId: instance.id, textLayersCopied: text.copied, warnings: text.warnings };
  } catch (error) {
    if (!instance.removed) instance.remove();
    throw error;
  }
}

async function replace(ids) {
  if (figma.currentPage.id !== scanPageId) throw new Error("当前页面已切换，请重新扫描。");
  const uniqueIds = [...new Set(ids)];
  if (!uniqueIds.length) throw new Error("请先勾选需要替换的图层。");
  const report = { version: 1, createdAt: new Date().toISOString(), pageName: figma.currentPage.name, pageId: scanPageId, succeeded: 0, failed: 0, entries: [] };
  for (const id of uniqueIds) {
    const item = preview.get(id);
    try {
      if (!item) throw new Error("该图层不在当前预览中，请重新扫描。");
      const result = await replaceOne(item);
      report.entries.push({ sourceNodeId: id, sourceName: item.name, componentId: item.componentId, componentName: item.componentName, status: "success", ...result });
      report.succeeded++;
      preview.delete(id);
    } catch (error) {
      report.entries.push({ sourceNodeId: id, sourceName: item ? item.name : id, status: "failed", reason: errorMessage(error) });
      report.failed++;
    }
    send("progress", { completed: report.entries.length, total: uniqueIds.length });
  }
  figma.commitUndo();
  send("report", { report });
  figma.notify(`替换完成：${report.succeeded} 成功，${report.failed} 失败`);
}

// Skill RPC: no arbitrary code execution. All writes require a fresh, bounded scan.
const skillScans = new Map();
const skillRequests = new Map();
const visualProperties = [
  'name','visible','locked','opacity','blendMode','isMask','maskType','effects','fills','strokes','strokeWeight','strokeAlign','strokeCap','strokeJoin','dashPattern','strokeMiterLimit',
  'topLeftRadius','topRightRadius','bottomLeftRadius','bottomRightRadius','cornerRadius','cornerSmoothing','clipsContent','width','height','rotation','relativeTransform',
  'constraints','layoutMode','layoutWrap','primaryAxisSizingMode','counterAxisSizingMode','primaryAxisAlignItems','counterAxisAlignItems','counterAxisAlignContent',
  'paddingLeft','paddingRight','paddingTop','paddingBottom','itemSpacing','counterAxisSpacing','strokesIncludedInLayout','itemReverseZIndex','layoutPositioning','layoutAlign','layoutGrow',
  'layoutSizingHorizontal','layoutSizingVertical','minWidth','maxWidth','minHeight','maxHeight','gridRowCount','gridColumnCount','gridRowGap','gridColumnGap','gridRowSizes','gridColumnSizes',
  'fontName','fontSize','textCase','textDecoration','letterSpacing','lineHeight','paragraphIndent','paragraphSpacing','textAlignHorizontal','textAlignVertical','textAutoResize','textTruncation','maxLines',
  'vectorPaths','vectorNetwork','arcData','pointCount','innerRadius','booleanOperation','exportSettings','reactions','boundVariables','explicitVariableModes',
  'fillStyleId','strokeStyleId','effectStyleId','textStyleId','gridStyleId','layoutGrids','hyperlink','listSpacing','hangingPunctuation','hangingList','textStyleOverrides','componentProperties'
];
function plain(value) {
  if (value === figma.mixed || typeof value === 'symbol') return '$mixed';
  if (value === undefined) return null;
  return JSON.parse(JSON.stringify(value));
}
function nodeRecord(node, equivalent = false, root = true, budget = {count: 0}) {
  if (++budget.count > 1500) throw new Error('扫描范围超过 1500 个节点，请缩小选择范围。');
  const record = {type: root && equivalent ? 'COMPONENT_ROOT' : node.type};
  if (!equivalent) { record.id = node.id; record.parentId = node.parent && node.parent.id; }
  for (const key of visualProperties) {
    if (!(key in node)) continue;
    if (equivalent && root && ['name','constraints','layoutPositioning','layoutAlign','layoutGrow','layoutSizingHorizontal','layoutSizingVertical'].includes(key)) continue;
    let value = plain(node[key]);
    if (equivalent && root && key === 'relativeTransform') value = value.map(row => [row[0],row[1],0]);
    record[key] = value;
  }
  if (node.type === 'TEXT') {
    if (!equivalent) record.characters = node.characters;
    // Only uniformly styled text is migrated; mixed runs need a richer override engine.
    record.textSegments = node.characters.length ? node.getStyledTextSegments(['fontName','fontSize','fills','textStyleId','fillStyleId','textCase','textDecoration','letterSpacing','lineHeight','hyperlink','listOptions','indentation']).map(segment => {
      const copy = plain(segment);
      if (equivalent) { delete copy.characters; delete copy.start; delete copy.end; }
      return copy;
    }) : [];
  }
  if ('children' in node) record.children = node.children.map(child => nodeRecord(child,equivalent,false,budget));
  return record;
}
function fingerprint(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  let hash = 2166136261;
  for (let i=0;i<text.length;i++) { hash ^= text.charCodeAt(i); hash = Math.imul(hash,16777619); }
  return (hash >>> 0).toString(16);
}
function equivalentRecord(node) { return JSON.stringify(nodeRecord(node,true)); }
function assertSafeTree(node, options = {}) {
  if (node.visible === false || node.locked === true) throw new Error('包含隐藏或锁定图层，暂不自动组件化。');
  if (!options.allowInteractions && 'reactions' in node && node.reactions.length) throw new Error('包含交互连线，暂不自动组件化。');
  if (!options.allowNestedComponents && ['INSTANCE','COMPONENT','COMPONENT_SET'].includes(node.type)) throw new Error('包含嵌套组件，暂不自动组件化。');
  if (node.type === 'TEXT') {
    const record = nodeRecord(node,true);
    if (record.textSegments.length > 1 || JSON.stringify(record).includes('"$mixed"')) throw new Error('包含混合文本样式，暂不自动组件化。');
  }
  for (const child of node.children || []) assertSafeTree(child, options);
}
async function skillScan(args) {
  await init();
  const scope = args.scope || 'selection';
  if (!['selection','page'].includes(scope)) throw new Error('scope 必须为 selection 或 page。');
  const page = figma.currentPage;
  let roots = scope === 'page' ? [...page.children] : [...page.selection];
  if (!roots.length) throw new Error('请先在 Figma 中选择需要扫描的设计稿。');
  roots = roots.filter(node => !roots.some(other => other !== node && isAncestor(other,node)));
  const budget = {count: 0};
  const trees = roots.map(node => nodeRecord(node,false,true,budget));
  function compactScan(record) {
    for (const key of ['vectorPaths','vectorNetwork']) if (record[key]) { const raw=JSON.stringify(record[key]); record[key]={fingerprint:fingerprint(raw),serializedBytes:raw.length}; }
    for (const child of record.children || []) compactScan(child);
  }
  trees.forEach(compactScan);
  if (JSON.stringify(trees).length > 2000000) throw new Error('扫描结果过大，请缩小选择范围。');
  const candidates = [];
  const skipped = [];
  const snapshots = new Map();
  function walk(node) {
    if (excluded.has(node.type) || node.visible === false || node.locked === true) {
      skipped.push({id:node.id,reason:excluded.has(node.type) ? '已有组件或实例' : node.visible === false ? '隐藏图层' : '锁定图层'});
      return;
    }
    if (eligible(node)) {
      if (candidates.length >= 1000) throw new Error('可选容器超过 1000 个，请缩小扫描范围。');
      const full = JSON.stringify(nodeRecord(node));
      const equivalence = equivalentRecord(node);
      let blockedReason = null;
      try { assertSafeTree(node); } catch (error) { blockedReason = errorMessage(error); }
      snapshots.set(node.id, {full,equivalence});
      candidates.push({id:node.id,name:node.name,path:pathOf(node),type:node.type,width:node.width,height:node.height,signature:fingerprint(equivalence),blockedReason});
    }
    for (const child of node.children || []) walk(child);
  }
  roots.forEach(walk);
  const componentOffset = args.componentOffset === undefined ? 0 : args.componentOffset;
  if (!Number.isInteger(componentOffset) || componentOffset < 0) throw new Error('componentOffset 必须为非负整数。');
  if (componentOffset > components.length) throw new Error(`componentOffset 超出本地组件总数 ${components.length}。`);
  const componentWindow = components.slice(componentOffset,componentOffset+200);
  const local = componentWindow.map(node => ({id:node.id,name:node.name,path:pathOf(node),width:node.width,height:node.height,signature:fingerprint(equivalentRecord(node))}));
  const componentSnapshots = new Map(componentWindow.map(node => [node.id,JSON.stringify(nodeRecord(node))]));
  const scanId = `scan-${fingerprint({pageId:page.id,scope,trees,components:[...componentSnapshots]})}`;
  skillScans.clear();
  skillScans.set(scanId,{pageId:page.id,snapshots,componentSnapshots});
  return {scanId,pageId:page.id,pageName:page.name,scope,trees,candidates,skipped,components:local,componentOffset,componentTotal:components.length,nextComponentOffset:componentOffset+200<components.length ? componentOffset+200 : null,componentsTruncated:componentWindow.length<components.length,nodeCount:budget.count};
}
function isAncestor(ancestor,node) {
  for (let current=node.parent;current;current=current.parent) if (current.id===ancestor.id) return true;
  return false;
}
async function exactText(source,target) {
  if (source.type === 'TEXT') {
    if (target.type !== 'TEXT') throw new Error('文本结构不一致。');
    await figma.loadFontAsync(source.fontName);
    target.characters = source.characters;
  }
  const left = source.children || [], right = target.children || [];
  if (left.length !== right.length) throw new Error('组件结构不一致。');
  for (let i=0;i<left.length;i++) await exactText(left[i],right[i]);
}

// Keep generated components in one durable page. Older versions created a new
// page for every run (`Skill Components · scan-*`); reuse the canonical page
// when present and otherwise pick the historical page with the most components.
function findOrCreateComponentsPage() {
  const pages = (figma.root.children || []).filter(page => page.type === 'PAGE');
  const canonical = pages.find(page => page.name === 'Skill Components');
  if (canonical) return canonical;
  const historical = pages
    .filter(page => /^Skill Components(?: · .*)?$/.test(page.name || ''))
    .sort((a,b) => {
      const ac = (a.children || []).filter(node => node.type === 'COMPONENT' || node.type === 'COMPONENT_SET').length;
      const bc = (b.children || []).filter(node => node.type === 'COMPONENT' || node.type === 'COMPONENT_SET').length;
      return bc - ac;
    })[0];
  if (historical) return historical;
  const page = figma.createPage();
  page.name = 'Skill Components';
  return page;
}

function nextComponentY(page) {
  const gap = 80;
  const bottom = (page.children || []).reduce((max, node) => {
    const height = Number.isFinite(node.height) ? node.height : 0;
    const y = Number.isFinite(node.y) ? node.y : 0;
    return Math.max(max, y + height);
  }, 0);
  return bottom > 0 ? bottom + gap : 0;
}

async function skillApply(args) {
  const scan = skillScans.get(args.scanId);
  if (!scan || scan.pageId !== figma.currentPage.id) throw new Error('扫描已失效或页面已切换，请重新扫描。');
  const families = Array.isArray(args.families) ? args.families : [];
  const reuse = Array.isArray(args.reuse) ? args.reuse : [];
  const allowInteractions = args.allowInteractions === true;
  const allowNestedComponents = args.allowNestedComponents === true;
  const ids = families.flatMap(family => family.sourceIds || []).concat(reuse.map(item => item.sourceId));
  if (!ids.length || ids.length > 200 || new Set(ids).size !== ids.length) throw new Error('提交必须包含 1–200 个不重复的源图层。');
  const sources = new Map();
  // Validate the entire proposal before any mutation.
  for (const id of ids) {
    const node = await figma.getNodeByIdAsync(id), snapshot = scan.snapshots.get(id);
    if (!node || !snapshot || !eligible(node) || JSON.stringify(nodeRecord(node)) !== snapshot.full) throw new Error(`源图层 ${id} 已改变或不在扫描中，请重新扫描。`);
    assertSafeTree(node, { allowInteractions, allowNestedComponents });
    sources.set(id,node);
  }
  for (const node of sources.values()) for (const other of sources.values()) if (isAncestor(node,other)) throw new Error('不能同时替换父容器和其子图层。');
  const replacedIds = new Set();
  function collectIds(node) { replacedIds.add(node.id); for (const child of node.children || []) collectIds(child); }
  for (const source of sources.values()) collectIds(source);
  function linksToSource(value) {
    if (!value || typeof value !== 'object') return false;
    if (value.destinationId && replacedIds.has(value.destinationId)) return true;
    return Object.values(value).some(linksToSource);
  }
  // Dynamic-page documents reject root-wide traversal unless every page is loaded.
  // The scan and mutation are scoped to the current page, so inspect only that page.
  const incoming = figma.currentPage.findAll(node => 'reactions' in node && linksToSource(node.reactions));
  if (incoming.length && !allowInteractions) throw new Error('存在指向待替换图层的原型交互连线，暂不自动替换。');
  for (const family of families) {
    if (typeof family.name !== 'string' || !family.name.trim() || !family.sourceIds.length) throw new Error('组件族需要名称与 sourceIds。');
    const first = scan.snapshots.get(family.sourceIds[0]).equivalence;
    for (const id of family.sourceIds) if (scan.snapshots.get(id).equivalence !== first) throw new Error(`组件族 ${family.name} 的结构或样式不一致，请拆成不同组件族。`);
  }
  const targets = new Map();
  for (const item of reuse) {
    const target = await figma.getNodeByIdAsync(item.componentId);
    if (!target || target.type !== 'COMPONENT' || !scan.componentSnapshots.has(target.id) || JSON.stringify(nodeRecord(target)) !== scan.componentSnapshots.get(target.id)) throw new Error('复用组件不在扫描中或已经改变。');
    // A component root itself is allowed; nested instances and interactions are not.
    for (const child of target.children) assertSafeTree(child);
    if (equivalentRecord(target) !== scan.snapshots.get(item.sourceId).equivalence) throw new Error('复用组件与源图层的结构或样式不一致。');
    targets.set(item.sourceId,target);
  }
  const originalPage = figma.currentPage;
  // New component families are appended to the existing component page. A
  // page is created only the first time the skill is used in a file.
  const generatedPage = families.length ? findOrCreateComponentsPage() : null;
  const report = {scanId:args.scanId,createdAt:new Date().toISOString(),pageId:originalPage.id,generatedPageId:generatedPage && generatedPage.id,backupPageId:null,createdComponents:[],entries:[],succeeded:0,failed:0};
  let nextY = generatedPage ? nextComponentY(generatedPage) : 0;
  const familyErrors = new Map();
  for (const family of families) {
    let clone;
    try {
      clone = sources.get(family.sourceIds[0]).clone();
      generatedPage.appendChild(clone);
      const component = figma.createComponentFromNode(clone);
      component.name = family.name.trim();
      component.x = 0; component.y = nextY;
      nextY += component.height + 80;
      component.description = typeof family.reason === 'string' ? family.reason : 'Generated by design-system skill';
      report.createdComponents.push({id:component.id,name:component.name,height:component.height,sourceIds:family.sourceIds});
      for (const id of family.sourceIds) targets.set(id,component);
    } catch (error) {
      if (clone && !clone.removed) clone.remove();
      for (const id of family.sourceIds) familyErrors.set(id,errorMessage(error));
    }
  }
  const targetFingerprints = new Map([...new Set(targets.values())].map(node => [node.id,JSON.stringify(nodeRecord(node))]));
  for (const id of ids) {
    let instance;
    const source = sources.get(id), component = targets.get(id);
    try {
      if (familyErrors.has(id)) throw new Error(familyErrors.get(id));
      if (JSON.stringify(nodeRecord(source)) !== scan.snapshots.get(id).full) throw new Error('源图层在执行中发生变化，请重新扫描。');
      if (JSON.stringify(nodeRecord(component)) !== targetFingerprints.get(component.id)) throw new Error('目标组件在执行中改变。');
      instance = component.createInstance();
      await exactText(source,instance);
      if (JSON.stringify(nodeRecord(component)) !== targetFingerprints.get(component.id)) throw new Error('等待字体期间目标组件改变。');
      if (JSON.stringify(nodeRecord(source)) !== scan.snapshots.get(id).full) throw new Error('等待字体期间源图层改变。');
      const parent = source.parent, index = parent.children.indexOf(source), transform = plain(source.relativeTransform);
      // Inserting a second child can immediately reflow the source in Auto Layout.
      // Capture its intended sizing before mutating the parent, and restore sizing
      // modes only after resize (which can reset them to FIXED).
      const size = {width:source.width,height:source.height};
      const layout = {};
      for (const key of ['constraints','layoutPositioning','layoutAlign','layoutGrow','layoutSizingHorizontal','layoutSizingVertical']) {
        if (key in source && key in instance) layout[key] = plain(source[key]);
      }
      if (size.width < 0.01 || size.height < 0.01) throw new Error('零尺寸图层无法安全替换。');
      instance.name = source.name;
      instance.resize(size.width,size.height);
      parent.insertChild(index,instance);
      for (const key of Object.keys(layout)) instance[key] = layout[key];
      instance.relativeTransform = transform;
      const parentUsesAutoLayout = 'layoutMode' in parent && parent.layoutMode !== 'NONE';
      // The final Auto Layout geometry settles only once the source is removed.
      // For other parents, reject a geometric mismatch while rollback is trivial.
      const geometryChecked = !parentUsesAutoLayout;
      if (geometryChecked) {
        const tolerance = 0.05;
        const transformMatches = instance.relativeTransform.every((row,r) => row.every((value,c) => Math.abs(value-transform[r][c]) <= tolerance));
        if (Math.abs(instance.width-size.width) > tolerance || Math.abs(instance.height-size.height) > tolerance || !transformMatches) {
          throw new Error('替换实例的尺寸或位置与原图层不一致，已保留原图层。');
        }
      }
      source.remove();
      report.entries.push({sourceId:id,newNodeId:instance.id,componentId:component.id,backupNodeId:null,status:'success',geometryChecked});
      report.succeeded++;
    } catch (error) {
      if (instance && !instance.removed) instance.remove();
      report.entries.push({sourceId:id,status:'failed',reason:errorMessage(error),backupNodeId:null});
      report.failed++;
    }
  }
  skillScans.clear();
  figma.commitUndo();
  send('report',{report});
  return report;
}
async function skillVerify(args) {
  const entries = Array.isArray(args.entries) ? args.entries : [];
  if (entries.length > 200) throw new Error('验证最多支持 200 个条目。');
  const results = [];
  for (const entry of entries) {
    const instance = entry.newNodeId ? await figma.getNodeByIdAsync(entry.newNodeId) : null;
    const original = entry.sourceId ? await figma.getNodeByIdAsync(entry.sourceId) : null;
    const main = instance && instance.type === 'INSTANCE' ? await instance.getMainComponentAsync() : null;
    results.push({sourceId:entry.sourceId,newNodeId:entry.newNodeId,backupNodeId:null,instanceExists:!!instance && instance.type === 'INSTANCE',componentId:main && main.id,componentMatches:!!main && main.id === entry.componentId,backupExists:false,originalRemoved:!original,status:instance && main && main.id === entry.componentId && !original ? 'verified' : 'failed'});
  }
  return {entries:results,verified:results.filter(item=>item.status === 'verified').length,failed:results.filter(item=>item.status !== 'verified').length};
}

async function skillClear(args) {
  const page = figma.currentPage;
  const removeInteractions = args.removeInteractions !== false;
  const detachInstances = args.detachInstances !== false;
  let detachedInstances = 0, removedInteractions = 0, componentNodes = 0;
  function clearReactions(node) {
    if (!removeInteractions || !('reactions' in node) || !node.reactions || !node.reactions.length) return;
    try {
      if (typeof node.setReactionsAsync === 'function') node.setReactionsAsync([]);
      else node.reactions = [];
      removedInteractions++;
    } catch (_) {}
  }
  const all = page.findAll(() => true);
  for (const node of all) {
    clearReactions(node);
    if (node.type === 'COMPONENT' || node.type === 'COMPONENT_SET') componentNodes++;
  }
  // Detach only top-level instances. Detaching a parent invalidates nested
  // instance handles, so detaching every descendant would race the document.
  if (detachInstances) {
    const roots = all.filter(node => node.type === 'INSTANCE' && !(() => {
      let parent = node.parent;
      while (parent && parent !== page) { if (parent.type === 'INSTANCE') return true; parent = parent.parent; }
      return false;
    })());
    for (const node of roots) {
      try { if (node.parent) { node.detachInstance(); detachedInstances++; } } catch (_) {}
    }
  }
  return {pageId:page.id,pageName:page.name,detachedInstances,removedInteractions,componentNodes,removeInteractions,detachInstances};
}
async function skillCommand(message) {
  const {requestId,command} = message;
  if (typeof requestId !== 'string' || !requestId) { send('skill-result',{requestId,error:'requestId is required'}); return; }
  const payload = JSON.stringify({command,args:message.args || {}});
  if (skillRequests.has(requestId)) {
    const cached = skillRequests.get(requestId);
    if (cached.payload !== payload) send('skill-result',{requestId,error:'requestId already used with a different payload'});
    else send('skill-result',await cached.promise);
    return;
  }
  if (busy) { send('skill-result',{requestId,error:'Plugin is busy; retry after the active request completes.'}); return; }
  busy = true;
  const promise = (async () => {
    try {
      const args = message.args || {};
      if (args._bridgePageId && args._bridgePageId !== figma.currentPage.id && ['scan','apply'].includes(command)) throw new Error('连接后页面已切换，请重新连接插件。');
      let result;
      if (command === 'ping') result = {fileName:figma.root.name,pageId:figma.currentPage.id,pageName:figma.currentPage.name,selection:figma.currentPage.selection.map(node=>({id:node.id,name:node.name}))};
      else if (command === 'scan') result = await skillScan(args);
      else if (command === 'apply') result = await skillApply(args);
      else if (command === 'verify') result = await skillVerify(args);
      else if (command === 'clear') result = await skillClear(args);
      else throw new Error('Unknown skill command');
      return {requestId,result};
    } catch (error) { return {requestId,error:errorMessage(error)}; }
    finally { busy = false; }
  })();
  skillRequests.set(requestId,{payload,promise});
  send('skill-result',await promise);
}

figma.ui.onmessage = async message => {
  if (message.type === "skill-command") { await skillCommand(message); return; }
  if (busy) return;
  busy = true;
  try {
    if (message.type === "init") await init();
    else if (message.type === "scan") scan(Array.isArray(message.rules) ? message.rules : []);
    else if (message.type === "replace") await replace(Array.isArray(message.ids) ? message.ids : []);
    else if (message.type === "focus") {
      const node = await figma.getNodeByIdAsync(message.id);
      if (node && "visible" in node) { figma.currentPage.selection = [node]; figma.viewport.scrollAndZoomIntoView([node]); }
    }
  } catch (error) { send("error", { message: errorMessage(error) }); }
  finally { busy = false; }
};
