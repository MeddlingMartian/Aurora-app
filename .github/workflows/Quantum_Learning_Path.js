/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║  {/} QUANTUM CUBE — PERPETUAL LEARNING PATH ENGINE              ║
 * ║  MODULE: ION_LearningPath_v2.js                                  ║
 * ║  TARGET: Perpetual Knowledge Synthesis / Extinct Species Data    ║
 * ║  STATUS: ACTIVE — SELF-UPDATING CURRICULUM GRAPH                 ║
 * ╚══════════════════════════════════════════════════════════════════╝
 *
 * ARCHITECTURE:
 *   KnowledgeNode    — Discrete unit of knowledge with dependencies & mastery
 *   KnowledgeGraph   — Directed acyclic graph of all learnable nodes
 *   MasteryTracker   — Tracks mastery scores with entropy decay over time
 *   PerpetualEngine  — The core tick-loop that perpetually selects, learns,
 *                      and re-prioritizes the optimal next knowledge node
 *   QuantumCubeSync  — Namespace that wires all components to the ION context
 */

"use strict";

const EventEmitter = require("events");

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 1 — DATA STRUCTURES
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Represents a single learnable unit of knowledge.
 * In the ION context this maps to one molecular component (e.g. CSID 9700).
 */
class KnowledgeNode {
  /**
   * @param {string}   id           — Unique identifier (e.g. "CSID_9700")
   * @param {string}   label        — Human-readable name  ("Calcium Carbonate")
   * @param {string[]} prerequisites — IDs that must be mastered first
   * @param {number}   phiWeight    — Synthesis complexity (higher ⟹ harder)
   * @param {object}   metadata     — Arbitrary domain data (species, function…)
   */
  constructor(id, label, prerequisites = [], phiWeight = 1.0, metadata = {}) {
    if (!id || typeof id !== "string") throw new TypeError("KnowledgeNode: id must be a non-empty string");
    if (phiWeight <= 0) throw new RangeError("KnowledgeNode: phiWeight must be positive");

    this.id            = id;
    this.label         = label;
    this.prerequisites = prerequisites;
    this.phiWeight     = phiWeight;   // complexity multiplier
    this.metadata      = metadata;
    this.createdAt     = Date.now();
  }

  toString() {
    return `[${this.id}] ${this.label} (φ=${this.phiWeight.toFixed(2)})`;
  }
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * A directed acyclic graph of KnowledgeNodes.
 * Provides topological ordering for safe traversal and dependency validation.
 */
class KnowledgeGraph {
  constructor() {
    /** @type {Map<string, KnowledgeNode>} */
    this._nodes = new Map();
  }

  /**
   * Add a node to the graph.  Validates all declared prerequisites exist.
   * @param {KnowledgeNode} node
   */
  addNode(node) {
    if (!(node instanceof KnowledgeNode)) throw new TypeError("KnowledgeGraph: argument must be a KnowledgeNode");
    for (const prereq of node.prerequisites) {
      if (!this._nodes.has(prereq)) {
        throw new ReferenceError(`KnowledgeGraph: prerequisite "${prereq}" not found for node "${node.id}"`);
      }
    }
    this._nodes.set(node.id, node);
    return this;   // fluent API
  }

  /** @param {string} id @returns {KnowledgeNode|undefined} */
  getNode(id) { return this._nodes.get(id); }

  /** @returns {KnowledgeNode[]} */
  allNodes() { return [...this._nodes.values()]; }

  /**
   * Kahn's algorithm — returns nodes in valid learning order.
   * Nodes with zero unresolved prerequisites come first.
   * @returns {KnowledgeNode[]}
   */
  topologicalSort() {
    const inDegree = new Map([...this._nodes.keys()].map(k => [k, 0]));
    for (const node of this._nodes.values()) {
      for (const dep of node.prerequisites) inDegree.set(node.id, (inDegree.get(node.id) || 0) + 1);
    }

    const queue  = [...inDegree.entries()].filter(([, d]) => d === 0).map(([id]) => id);
    const result = [];

    while (queue.length) {
      const id   = queue.shift();
      const node = this._nodes.get(id);
      result.push(node);

      // Find nodes that depended on this one and reduce their in-degree
      for (const candidate of this._nodes.values()) {
        if (candidate.prerequisites.includes(id)) {
          const newDeg = (inDegree.get(candidate.id) || 1) - 1;
          inDegree.set(candidate.id, newDeg);
          if (newDeg === 0) queue.push(candidate.id);
        }
      }
    }

    if (result.length !== this._nodes.size) throw new Error("KnowledgeGraph: cycle detected — graph is not acyclic");
    return result;
  }

  /**
   * Returns all nodes whose prerequisites are fully satisfied by the given mastery map.
   * @param {Map<string, number>} masteryMap  — nodeId → mastery score (0–1)
   * @param {number}              threshold   — minimum mastery to count as "done"
   * @returns {KnowledgeNode[]}
   */
  availableNodes(masteryMap, threshold = 0.75) {
    return this.allNodes().filter(node =>
      !node.prerequisites.every(dep => (masteryMap.get(dep) || 0) >= threshold) === false
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Tracks mastery scores for every KnowledgeNode.
 * Applies exponential entropy decay so knowledge "fades" without review.
 *
 * Mastery model:
 *   mastery(t) = mastery(t₀) · e^(−λ · Δt)
 *   where λ is the decay constant (default: natural decay over ~72 hours to 50%)
 */
class MasteryTracker {
  /**
   * @param {number} decayConstant  — λ value (units: 1/ms). Default ≈ 72-hour half-life.
   * @param {number} masteryFloor   — Minimum mastery (knowledge never drops to 0)
   */
  constructor(decayConstant = 2.67e-9, masteryFloor = 0.05) {
    this._decayConstant = decayConstant;
    this._masteryFloor  = masteryFloor;

    /** @type {Map<string, { score: number, lastUpdated: number }>} */
    this._records = new Map();
  }

  /**
   * Record a learning event for a node. Mastery increases proportionally to
   * the time invested and inversely to the node's phi complexity.
   *
   * @param {string} nodeId
   * @param {number} phiWeight      — node complexity
   * @param {number} sessionMinutes — how long the study session lasted
   */
  recordLearning(nodeId, phiWeight, sessionMinutes) {
    const current = this._currentMastery(nodeId);
    // Diminishing-returns gain: more complex nodes require more effort
    const gain    = (1 - current) * (sessionMinutes / (sessionMinutes + phiWeight * 10));
    const updated = Math.min(1.0, current + gain);
    this._records.set(nodeId, { score: updated, lastUpdated: Date.now() });
    return updated;
  }

  /**
   * Returns the live (decay-adjusted) mastery score for a node.
   * @param {string} nodeId
   * @returns {number} 0–1
   */
  getMastery(nodeId) { return this._currentMastery(nodeId); }

  /** Returns a plain Map of all current mastery scores (after decay). */
  snapshot() {
    const out = new Map();
    for (const [id] of this._records) out.set(id, this._currentMastery(id));
    return out;
  }

  // ── private ────────────────────────────────────────────────────────────────

  _currentMastery(nodeId) {
    const record = this._records.get(nodeId);
    if (!record) return 0;
    const Δt     = Date.now() - record.lastUpdated;
    const decayed = record.score * Math.exp(-this._decayConstant * Δt);
    return Math.max(this._masteryFloor, decayed);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 2 — THE PERPETUAL ENGINE
// ─────────────────────────────────────────────────────────────────────────────

/**
 * PerpetualLearningEngine
 * ─────────────────────────────────────────────────────────────────────────────
 * The heart of the system.  On every "tick" it:
 *   1. Applies mastery decay across all nodes
 *   2. Identifies all currently available (unlocked) nodes
 *   3. Scores each available node with a PRIORITY formula:
 *        priority = urgencyScore × discoveryBonus / phiWeight
 *        urgencyScore  = 1 − mastery  (low mastery ⟹ high urgency)
 *        discoveryBonus = bonus for nodes never studied before
 *   4. Selects the highest-priority node
 *   5. Simulates a study session and updates mastery
 *   6. Emits lifecycle events for external listeners
 *   7. Checks for graph completion and either emits "complete" or
 *      dynamically expands the graph with newly discovered nodes
 *
 * Emits:
 *   "tick"     ({ cycle, selected, priority, mastery })  — every cycle
 *   "mastered" ({ nodeId, label })                        — when node hits ≥ threshold
 *   "expanded" ({ newNode })                              — when graph is expanded
 *   "complete" ({ totalCycles, energyPool })              — when all nodes mastered
 *   "error"    (Error)                                    — on internal failure
 */
class PerpetualLearningEngine extends EventEmitter {
  /**
   * @param {KnowledgeGraph}  graph
   * @param {MasteryTracker}  tracker
   * @param {object}          options
   * @param {number}          options.tickIntervalMs     — ms between cycles (default 3000)
   * @param {number}          options.sessionMinutes     — simulated study duration per tick
   * @param {number}          options.masteryThreshold   — score that counts as "mastered"
   * @param {number}          options.maxCycles          — 0 = truly perpetual
   * @param {boolean}         options.autoExpand         — discover new nodes after completion
   */
  constructor(graph, tracker, options = {}) {
    super();
    this._graph   = graph;
    this._tracker = tracker;
    this._opts    = {
      tickIntervalMs:   options.tickIntervalMs   ?? 3_000,
      sessionMinutes:   options.sessionMinutes   ?? 20,
      masteryThreshold: options.masteryThreshold ?? 0.85,
      maxCycles:        options.maxCycles        ?? 0,       // 0 = infinite
      autoExpand:       options.autoExpand        ?? true,
    };

    this._cycle      = 0;
    this._energyPool = 0;
    this._timer      = null;
    this._running    = false;
    this._masteredSet = new Set();

    // Discovery queue: pre-loaded with expansion candidates
    this._discoveryQueue = [];
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /** Start the perpetual learning loop. */
  start() {
    if (this._running) return this;
    this._running = true;
    this._log("ION ENGINE ONLINE — Perpetual Learning Path initialized.");
    this._scheduleNextTick();
    return this;
  }

  /** Pause the engine (state is preserved). */
  pause() {
    this._running = false;
    clearTimeout(this._timer);
    this._log("ENGINE PAUSED.");
    return this;
  }

  /** Resume after a pause. */
  resume() {
    if (this._running) return this;
    this._running = true;
    this._log("ENGINE RESUMED.");
    this._scheduleNextTick();
    return this;
  }

  /**
   * Queue a new KnowledgeNode for dynamic graph expansion.
   * It will be added on the next tick after all prerequisites are met.
   * @param {KnowledgeNode} node
   */
  enqueueDiscovery(node) {
    this._discoveryQueue.push(node);
    return this;
  }

  /** Current cycle count. */
  get cycle() { return this._cycle; }

  /** Total accumulated energy (proxy for total learning effort). */
  get energyPool() { return this._energyPool; }

  // ── Core tick ──────────────────────────────────────────────────────────────

  _tick() {
    if (!this._running) return;

    try {
      this._cycle++;
      const masteryMap = this._tracker.snapshot();

      // ── 1. Try to expand graph from discovery queue ─────────────────────
      this._attemptGraphExpansion(masteryMap);

      // ── 2. Determine available (unlocked) nodes ──────────────────────────
      const available = this._graph.availableNodes(masteryMap, this._opts.masteryThreshold);

      if (available.length === 0) {
        // All nodes mastered — check for pending discoveries or emit complete
        if (this._discoveryQueue.length === 0) {
          const summary = {
            totalCycles: this._cycle,
            energyPool:  parseFloat(this._energyPool.toFixed(4)),
            mastered:    [...this._masteredSet],
          };
          this.emit("complete", summary);
          if (!this._opts.autoExpand) {
            this._running = false;
            return;
          }
          // autoExpand: keep running — external code may enqueue more nodes
        }
        this._scheduleNextTick();
        return;
      }

      // ── 3. Score and select the best node ───────────────────────────────
      const scored   = available.map(node => ({
        node,
        priority: this._computePriority(node, masteryMap),
      }));
      scored.sort((a, b) => b.priority - a.priority);
      const { node: selected, priority } = scored[0];

      // ── 4. Simulate learning session ─────────────────────────────────────
      const newMastery = this._tracker.recordLearning(
        selected.id,
        selected.phiWeight,
        this._opts.sessionMinutes
      );

      // ── 5. Harvest energy (ION-style: complexity-weighted) ───────────────
      const energyGained = this._harvestEnergy(selected.phiWeight, this._opts.sessionMinutes);
      this._energyPool  += energyGained;

      // ── 6. Emit tick event ───────────────────────────────────────────────
      this.emit("tick", {
        cycle:        this._cycle,
        selected:     selected.toString(),
        priority:     parseFloat(priority.toFixed(4)),
        newMastery:   parseFloat(newMastery.toFixed(4)),
        energyGained: parseFloat(energyGained.toFixed(4)),
        energyPool:   parseFloat(this._energyPool.toFixed(4)),
      });

      // ── 7. Check mastery threshold ───────────────────────────────────────
      if (newMastery >= this._opts.masteryThreshold && !this._masteredSet.has(selected.id)) {
        this._masteredSet.add(selected.id);
        this.emit("mastered", { nodeId: selected.id, label: selected.label, mastery: newMastery });
      }

    } catch (err) {
      this.emit("error", err);
    }

    // ── 8. Schedule next tick (unless maxCycles hit) ─────────────────────
    if (this._opts.maxCycles === 0 || this._cycle < this._opts.maxCycles) {
      this._scheduleNextTick();
    } else {
      this._running = false;
      this._log(`Max cycles (${this._opts.maxCycles}) reached. Engine halted.`);
    }
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  /**
   * Priority formula:
   *   urgency      = 1 − currentMastery        (low mastery ⟹ most urgent)
   *   discoveryBonus = 2.0 if never studied, else 1.0
   *   phiPenalty   = 1 / phiWeight             (complex nodes score lower — harder)
   *
   *   priority = urgency × discoveryBonus × phiPenalty
   */
  _computePriority(node, masteryMap) {
    const mastery       = masteryMap.get(node.id) || 0;
    const urgency       = 1 - mastery;
    const neverStudied  = mastery === 0;
    const discoveryBonus = neverStudied ? 2.0 : 1.0;
    const phiPenalty    = 1 / node.phiWeight;
    return urgency * discoveryBonus * phiPenalty;
  }

  /** Energy model: study effort produces energy proportional to complexity × time. */
  _harvestEnergy(phiWeight, sessionMinutes) {
    return (phiWeight * sessionMinutes * 0.85) / 100;
  }

  /** Attempt to add discovery-queue nodes whose prerequisites are now met. */
  _attemptGraphExpansion(masteryMap) {
    const stillPending = [];
    for (const candidate of this._discoveryQueue) {
      const prereqsMet = candidate.prerequisites.every(
        dep => (masteryMap.get(dep) || 0) >= this._opts.masteryThreshold
      );
      if (prereqsMet) {
        try {
          this._graph.addNode(candidate);
          this.emit("expanded", { newNode: candidate.toString() });
          this._log(`Graph expanded with: ${candidate}`);
        } catch (e) {
          /* node already in graph — skip */
        }
      } else {
        stillPending.push(candidate);
      }
    }
    this._discoveryQueue = stillPending;
  }

  _scheduleNextTick() {
    this._timer = setTimeout(() => this._tick(), this._opts.tickIntervalMs);
  }

  _log(msg) { console.log(`[ION_LOG Cycle ${this._cycle}] ${msg}`); }
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 3 — QUANTUM CUBE ION SYSTEM WIRING
// ─────────────────────────────────────────────────────────────────────────────

/**
 * QuantumCubeSync
 * ─────────────────────────────────────────────────────────────────────────────
 * Wires the abstract Learning Path engine to the QUANTUM CUBE / ION domain.
 * Populates the KnowledgeGraph with molecular components for extinct species
 * and wires the engine's events to console output (replace with UI in prod).
 */
class QuantumCubeSync {
  constructor() {
    this.graph   = new KnowledgeGraph();
    this.tracker = new MasteryTracker();
    this.engine  = null;
  }

  /**
   * Load the Great Auk molecular synthesis curriculum.
   * Prerequisites are ordered by biochemical dependency logic:
   *   CaCO3 (bone) must come before Keratin (beak matrix built on bone structure)
   *   Crystallin (eye) requires Preen Oil (aquatic adaptation prerequisite)
   */
  loadGreatAukCurriculum() {
    // Tier 0 — Foundation
    this.graph.addNode(new KnowledgeNode(
      "CSID_9700",
      "Calcium Carbonate — Skeletal Foundation",
      [],           // no prerequisites
      1.8,
      { species: "Pinguinus impennis", function: "Flightless bone synthesis", csid: 9700 }
    ));

    // Tier 1 — Requires bone structure
    this.graph.addNode(new KnowledgeNode(
      "CSID_87431",
      "β-Keratin — Beak & Feather Matrix",
      ["CSID_9700"],   // needs skeletal foundation first
      2.4,
      { species: "Pinguinus impennis", function: "Rigid grooved beak", csid: 87431 }
    ));

    // Tier 1 — Parallel track (no bone dep needed)
    this.graph.addNode(new KnowledgeNode(
      "CSID_16736233",
      "Preen Oil Waxes — Aquatic Plumage",
      [],
      3.1,
      { species: "Pinguinus impennis", function: "Waterproof feather layer", csid: 16736233 }
    ));

    // Tier 2 — Requires aquatic adaptation
    this.graph.addNode(new KnowledgeNode(
      "CSID_10468600",
      "Crystallin — Underwater Eye Lens",
      ["CSID_16736233"],  // needs waterproofing / aquatic context
      4.2,
      { species: "Pinguinus impennis", function: "High-fidelity underwater vision", csid: 10468600 }
    ));

    return this;
  }

  /**
   * Pre-load a discovery queue with the Quagga pigment node —
   * it will only unlock after the Auk curriculum is complete,
   * simulating a perpetual cross-species learning expansion.
   */
  loadQuaggaExpansion() {
    // Will be added to the graph once CSID_87431 is mastered
    this.engine.enqueueDiscovery(new KnowledgeNode(
      "CSID_EUMELANIN",
      "Eumelanin — Quagga Stripe Pigment",
      ["CSID_87431"],    // keratin knowledge unlocks pigmentation study
      2.9,
      { species: "Equus quagga quagga", function: "Dorsal stripe melanin synthesis" }
    ));
    return this;
  }

  /** Wire engine events to formatted console output. */
  _attachListeners() {
    this.engine
      .on("tick", ev => {
        console.log(`\n╔═ CYCLE ${String(ev.cycle).padStart(3, "0")} ════════════════════════════════════════`);
        console.log(`║ 📡 Studying  : ${ev.selected}`);
        console.log(`║ ⚡ Priority  : ${ev.priority}`);
        console.log(`║ 🧠 Mastery   : ${(ev.newMastery * 100).toFixed(1)}%`);
        console.log(`║ 🔋 Energy    : +${ev.energyGained} → Pool: ${ev.energyPool} ION`);
        console.log(`╚${"═".repeat(49)}`);
      })
      .on("mastered", ev => {
        console.log(`\n  ✅ NODE MASTERED: "${ev.label}" [${(ev.mastery * 100).toFixed(1)}%]`);
      })
      .on("expanded", ev => {
        console.log(`\n  🔭 GRAPH EXPANDED → New node unlocked: ${ev.newNode}`);
      })
      .on("complete", ev => {
        console.log("\n╔══════════════════════════════════════════════════════════╗");
        console.log("║ 
