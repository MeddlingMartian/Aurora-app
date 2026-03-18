"""
╔══════════════════════════════════════════════════════════════════════╗
║  {/} QUANTUM CUBE — PERPETUAL LEARNING PATH ENGINE                  ║
║  MODULE: ION_LearningPath_v2.py                                      ║
║  TARGET: Extinct Species Molecular Synthesis / Perpetual Curriculum  ║
║  STATUS: ACTIVE — THREADED ASYNC LEARNING LOOP                       ║
╚══════════════════════════════════════════════════════════════════════╝

ARCHITECTURE:
  KnowledgeNode      — Dataclass: one learnable unit (molecule, concept, etc.)
  KnowledgeGraph     — DAG with topological sort + availability filtering
  MasteryTracker     — Score store with exponential entropy decay
  PerpetualEngine    — Priority-queue-driven perpetual tick loop (threading)
  ION_AutoCrawler_v2 — Extends the original crawler with learning path sync
  QuantumCubeSystem  — Top-level orchestrator wiring all components together

Python ≥ 3.10 required (dataclasses, match statement, type unions).
"""

from __future__ import annotations

import math
import time
import threading
import heapq
import logging
from dataclasses import dataclass, field
from typing      import Callable, Optional
from enum        import Enum, auto
from collections import deque

# ─── Logging ──────────────────────────────────────────────────────────────────
logging.basicConfig(
    level   = logging.INFO,
    format  = "[ION %(asctime)s | %(levelname)s] %(message)s",
    datefmt = "%H:%M:%S",
)
log = logging.getLogger("QUANTUM_CUBE")


# ═════════════════════════════════════════════════════════════════════════════
# SECTION 1 — DATA STRUCTURES
# ═════════════════════════════════════════════════════════════════════════════

class LearningStatus(Enum):
    LOCKED     = auto()   # prerequisites not yet met
    AVAILABLE  = auto()   # can be studied now
    IN_PROGRESS= auto()   # currently being studied
    MASTERED   = auto()   # mastery ≥ threshold


@dataclass
class KnowledgeNode:
    """
    One discrete unit of knowledge within the learning graph.
    In the ION context: one molecular component of an extinct species.

    Fields:
        node_id       : unique string identifier
        label         : human-readable name
        prerequisites : list of node_ids that must be mastered first
        phi_weight    : synthesis complexity (higher = harder to learn)
        metadata      : arbitrary domain data (species, CSID, function…)
    """
    node_id      : str
    label        : str
    prerequisites: list[str]              = field(default_factory=list)
    phi_weight   : float                  = 1.0
    metadata     : dict                   = field(default_factory=dict)
    created_at   : float                  = field(default_factory=time.time)

    def __post_init__(self):
        if not self.node_id:
            raise ValueError("KnowledgeNode: node_id must not be empty")
        if self.phi_weight <= 0:
            raise ValueError(f"KnowledgeNode {self.node_id}: phi_weight must be positive")

    def __str__(self) -> str:
        return f"[{self.node_id}] {self.label} (φ={self.phi_weight:.2f})"

    # Needed for heapq (tie-break on label)
    def __lt__(self, other: "KnowledgeNode") -> bool:
        return self.label < other.label


# ─────────────────────────────────────────────────────────────────────────────

class KnowledgeGraph:
    """
    Directed Acyclic Graph of KnowledgeNodes.
    Enforces prerequisite integrity and provides topological ordering.
    """

    def __init__(self) -> None:
        self._nodes: dict[str, KnowledgeNode] = {}

    def add_node(self, node: KnowledgeNode) -> "KnowledgeGraph":
        """
        Add a node.  All declared prerequisites must already exist in the graph.
        Returns self for chaining.
        """
        for dep in node.prerequisites:
            if dep not in self._nodes:
                raise KeyError(
                    f"KnowledgeGraph: prerequisite '{dep}' not found "
                    f"when adding '{node.node_id}'"
                )
        self._nodes[node.node_id] = node
        return self

    def get_node(self, node_id: str) -> Optional[KnowledgeNode]:
        return self._nodes.get(node_id)

    def all_nodes(self) -> list[KnowledgeNode]:
        return list(self._nodes.values())

    # ── Kahn's algorithm ─────────────────────────────────────────────────────
    def topological_sort(self) -> list[KnowledgeNode]:
        """
        Returns all nodes in a valid learning order (leaves first).
        Raises RuntimeError if a cycle is detected.
        """
        in_degree: dict[str, int] = {nid: 0 for nid in self._nodes}
        for node in self._nodes.values():
            for _ in node.prerequisites:
                in_degree[node.node_id] = in_degree.get(node.node_id, 0) + 1

        queue  = deque(nid for nid, d in in_degree.items() if d == 0)
        result : list[KnowledgeNode] = []

        while queue:
            nid  = queue.popleft()
            result.append(self._nodes[nid])
            for candidate in self._nodes.values():
                if nid in candidate.prerequisites:
                    in_degree[candidate.node_id] -= 1
                    if in_degree[candidate.node_id] == 0:
                        queue.append(candidate.node_id)

        if len(result) != len(self._nodes):
            raise RuntimeError("KnowledgeGraph: cycle detected — graph is not a DAG")
        return result

    def available_nodes(
        self,
        mastery_map : dict[str, float],
        threshold   : float = 0.75,
    ) -> list[KnowledgeNode]:
        """
        Return all nodes whose prerequisites are all at or above threshold.
        """
        return [
            node for node in self._nodes.values()
            if all((mastery_map.get(dep, 0.0) >= threshold) for dep in node.prerequisites)
        ]

    def status_of(
        self,
        node_id    : str,
        mastery_map: dict[str, float],
        threshold  : float,
    ) -> LearningStatus:
        node = self._nodes.get(node_id)
        if node is None:
            raise KeyError(f"Node '{node_id}' not in graph")
        if mastery_map.get(node_id, 0.0) >= threshold:
            return LearningStatus.MASTERED
        prereqs_met = all(mastery_map.get(dep, 0.0) >= threshold for dep in node.prerequisites)
        return LearningStatus.AVAILABLE if prereqs_met else LearningStatus.LOCKED

    def __len__(self) -> int:
        return len(self._nodes)


# ─────────────────────────────────────────────────────────────────────────────

class MasteryTracker:
    """
    Tracks mastery scores (0.0–1.0) per node with exponential entropy decay.

    Mastery decay model:
        mastery(t) = mastery(t₀) × e^(−λ × Δt_seconds)

    Default λ produces a ~72-hour half-life:
        λ = ln(2) / (72 × 3600) ≈ 2.67 × 10⁻⁶  s⁻¹
    """

    HALF_LIFE_HOURS : float = 72.0

    def __init__(
        self,
        half_life_hours: float = HALF_LIFE_HOURS,
        mastery_floor  : float = 0.05,
    ) -> None:
        λ_per_hour         = math.log(2) / half_life_hours
        self._lambda       = λ_per_hour / 3600          # convert to per-second
        self._floor        = mastery_floor
        # {node_id: (score, last_updated_time)}
        self._records      : dict[str, tuple[float, float]] = {}
        self._study_counts : dict[str, int] = {}
        self._lock         = threading.Lock()

    def record_learning(
        self,
        node_id       : str,
        phi_weight    : float,
        session_minutes: float,
    ) -> float:
        """
        Record a study session.  Mastery increases with a diminishing-returns
        formula scaled by session length and inversely by phi_weight.
        Returns the new mastery score.
        """
        with self._lock:
            current = self._live_mastery(node_id)
            # Gain formula: longer sessions + simpler nodes ⟹ more gain
            gain    = (1.0 - current) * (session_minutes / (session_minutes + phi_weight * 8.0))
            updated = min(1.0, current + gain)
            self._records[node_id]      = (updated, time.time())
            self._study_counts[node_id] = self._study_counts.get(node_id, 0) + 1
            return updated

    def get_mastery(self, node_id: str) -> float:
        with self._lock:
            return self._live_mastery(node_id)

    def snapshot(self) -> dict[str, float]:
        """Thread-safe snapshot of all current (decay-adjusted) mastery scores."""
        with self._lock:
            return {nid: self._live_mastery(nid) for nid in self._records}

    def study_count(self, node_id: str) -> int:
        return self._study_counts.get(node_id, 0)

    # ── private ───────────────────────────────────────────────────────────────

    def _live_mastery(self, node_id: str) -> float:
        """Must be called while self._lock is held."""
        if node_id not in self._records:
            return 0.0
        score, last_t = self._records[node_id]
        delta_t       = time.time() - last_t
        decayed       = score * math.exp(-self._lambda * delta_t)
        return max(self._floor, decayed)


# ═════════════════════════════════════════════════════════════════════════════
# SECTION 2 — THE PERPETUAL ENGINE
# ═════════════════════════════════════════════════════════════════════════════

@dataclass(order=True)
class _PrioritizedNode:
    """Heap entry for the priority queue (min-heap, so we negate priority)."""
    neg_priority: float
    node        : KnowledgeNode = field(compare=False)


class EngineEvent(Enum):
    TICK     = "tick"
    MASTERED = "mastered"
    EXPANDED = "expanded"
    COMPLETE = "complete"
    ERROR    = "error"


class PerpetualLearningEngine:
    """
    ─────────────────────────────────────────────────────────────────────────
    Thread-safe perpetual learning loop.

    On every tick:
      1. Build a priority-queue of all available (unlocked) nodes
      2. Pop the highest-priority node (urgency × discovery_bonus / phi)
      3. Simulate a study session and update MasteryTracker
      4. Emit an event dict to all registered listeners
      5. Attempt graph expansion from the discovery queue
      6. Emit COMPLETE if all nodes mastered and discovery queue is empty
      7. Sleep tick_interval_s and repeat

    Listeners are plain callables: fn(event: EngineEvent, payload: dict) → None
    ─────────────────────────────────────────────────────────────────────────
    """

    def __init__(
        self,
        graph            : KnowledgeGraph,
        tracker          : MasteryTracker,
        tick_interval_s  : float = 3.0,
        session_minutes  : float = 30.0,
        mastery_threshold: float = 0.82,
        max_cycles       : int   = 0,     # 0 = truly perpetual
        auto_expand      : bool  = True,
    ) -> None:
        self._graph             = graph
        self._tracker           = tracker
        self._tick_s            = tick_interval_s
        self._session_min       = session_minutes
        self._threshold         = mastery_threshold
        self._max_cycles        = max_cycles
        self._auto_expand       = auto_expand

        self._cycle             = 0
        self._energy_pool       = 0.0
        self._mastered_set      : set[str] = set()
        self._discovery_queue   : list[KnowledgeNode] = []
        self._listeners         : list[Callable] = []
        self._stop_event        = threading.Event()
        self._thread            : Optional[threading.Thread] = None
        self._lock              = threading.Lock()

    # ── Public API ────────────────────────────────────────────────────────────

    def add_listener(self, fn: Callable[[EngineEvent, dict], None]) -> None:
        self._listeners.append(fn)

    def enqueue_discovery(self, node: KnowledgeNode) -> None:
        with self._lock:
            self._discovery_queue.append(node)

    def start(self) -> None:
        self._stop_event.clear()
        self._thread = threading.Thread(target=self._run, daemon=True, name="ION-PerpetualEngine")
        self._thread.start()
        log.info("PerpetualLearningEngine ONLINE — daemon thread started.")

    def stop(self) -> None:
        self._stop_event.set()
        if self._thread:
            self._thread.join(timeout=self._tick_s + 1)
        log.info("PerpetualLearningEngine STOPPED.")

    def wait(self) -> None:
        """Block the calling thread until the engine stops."""
        if self._thread:
            self._thread.join()

    @property
    def cycle(self) -> int:
        return self._cycle

    @property
    def energy_pool(self) -> float:
        return self._energy_pool

    # ── Core loop ─────────────────────────────────────────────────────────────

    def _run(self) -> None:
        while not self._stop_event.is_set():
            try:
                self._tick()
            except Exception as exc:
                self._emit(EngineEvent.ERROR, {"error": str(exc), "cycle": self._cycle})
                log.exception("Engine error on cycle %d", self._cycle)

            if self._max_cycles and self._cycle >= self._max_cycles:
                log.info("Max cycles (%d) reached. Engine stopping.", self._max_cycles)
                break

            self._stop_event.wait(timeout=self._tick_s)

    def _tick(self) -> None:
        self._cycle += 1
        mastery_map  = self._tracker.snapshot()

        # ── 1. Try to expand graph ─────────────────────────────────────────
        self._attempt_expansion(mastery_map)

        # ── 2. Build priority queue ────────────────────────────────────────
        available = self._graph.available_nodes(mastery_map, self._threshold)
        # Filter out already-mastered nodes
        available = [n for n in available if mastery_map.get(n.node_id, 0) < self._threshold]

        if not available:
            with self._lock:
                pending = len(self._discovery_queue)
            if pending == 0:
                mastered = list(self._mastered_set)
                self._emit(EngineEvent.COMPLETE, {
                    "total_cycles": self._cycle,
                    "energy_pool" : round(self._energy_pool, 4),
                    "mastered"    : mastered,
                })
                if not self._auto_expand:
                    self._stop_event.set()
            return

        heap: list[_PrioritizedNode] = []
        for node in available:
            priority = self._compute_priority(node, mastery_map)
            heapq.heappush(heap, _PrioritizedNode(-priority, node))

        top      = heapq.heappop(heap)
        selected = top.node
        priority = -top.neg_priority

        # ── 3. Study session ───────────────────────────────────────────────
        new_mastery  = self._tracker.record_learning(
            selected.node_id, selected.phi_weight, self._session_min
        )

        # ── 4. Energy harvest ──────────────────────────────────────────────
        energy_gained     = self._harvest_energy(selected.phi_weight, self._session_min)
        self._energy_pool += energy_gained

        # ── 5. Emit tick ───────────────────────────────────────────────────
        self._emit(EngineEvent.TICK, {
            "cycle"       : self._cycle,
            "selected"    : str(selected),
            "priority"    : round(priority, 4),
            "new_mastery" : round(new_mastery, 4),
            "energy_gained": round(energy_gained, 4),
            "energy_pool" : round(self._energy_pool, 4),
        })

        # ── 6. Mastery threshold check ─────────────────────────────────────
        if new_mastery >= self._threshold and selected.node_id not in self._mastered_set:
            self._mastered_set.add(selected.node_id)
            self._emit(EngineEvent.MASTERED, {
                "node_id": selected.node_id,
                "label"  : selected.label,
                "mastery": round(new_mastery, 4),
            })

    # ── Helpers ───────────────────────────────────────────────────────────────

    def _compute_priority(self, node: KnowledgeNode, mastery_map: dict[str, float]) -> float:
        """
        priority = urgency × discovery_bonus × phi_penalty
          urgency        = 1 − mastery
          discovery_bonus = 2.0 if never studied, else 1.0
          phi_penalty    = 1 / phi_weight
        """
        mastery         = mastery_map.get(node.node_id, 0.0)
        urgency         = 1.0 - mastery
        discovery_bonus = 2.0 if self._tracker.study_count(node.node_id) == 0 else 1.0
        phi_penalty     = 1.0 / node.phi_weight
        return urgency * discovery_bonus * phi_penalty

    @staticmethod
    def _harvest_energy(phi_weight: float, session_minutes: float) -> float:
        return (phi_weight * session_minutes * 0.85) / 100.0

    def _attempt_expansion(self, mastery_map: dict[str, float]) -> None:
        with self._lock:
            still_pending = []
            for candidate in self._discovery_queue:
                prereqs_met = all(
                    mastery_map.get(dep, 0.0) >= self._threshold
                    for dep in candidate.prerequisites
                )
                if prereqs_met:
                    try:
                        self._graph.add_node(candidate)
                        self._emit(EngineEvent.EXPANDED, {"new_node": str(candidate)})
                        log.info("Graph EXPANDED → %s", candidate)
                    except KeyError:
                        pass  # already in graph
                else:
                    still_pending.append(candidate)
            self._discovery_queue = still_pending

    def _emit(self, event: EngineEvent, payload: dict) -> None:
        for listener in self._listeners:
            try:
                listener(event, payload)
            except Exception:
                log.exception("Listener raised an exception for event %s", event)


# ═════════════════════════════════════════════════════════════════════════════
# SECTION 3 — ION AUTO-CRAWLER v2 (Extended with Learning Path Sync)
# ═════════════════════════════════════════════════════════════════════════════

class ION_AutoCrawler_v2:
    """
    Extended version of ION_AutoCrawler_v1 (see original codeblock in prompt).
    Now integrates with PerpetualLearningEngine:
      • Each successfully crawled molecule is registered as a KnowledgeNode
      • Crawl results are fed into the tracker as initial study sessions
      • Failed crawls enqueue a retry via the discovery queue

    Requires a real ChemSpider API key for live operation.
    In demo mode (api_token=None) it operates with synthetic responses.
    """

    def __init__(self, engine: PerpetualLearningEngine, api_token: Optional[str] = None) -> None:
        self._engine    = engine
        self._api_token = api_token
        self._demo_mode = api_token is None
        if self._demo_mode:
            log.warning("ION_AutoCrawler_v2: running in DEMO MODE (no real API calls).")

    def crawl_and_register(
        self,
        component_name: str,
        node_id       : str,
        prerequisites : list[str] = (),
        phi_weight    : float     = 1.0,
    ) -> Optional[str]:
        """
        Crawl ChemSpider for component_name, then register it as a KnowledgeNode.
        Returns the CSID string on success, None on failure.
        """
        log.info("CRAWLER → querying '%s' …", component_name)
        csid = self._fetch_csid(component_name)

        if csid:
            node = KnowledgeNode(
                node_id      = node_id,
                label        = f"{component_name} (CSID {csid})",
                prerequisites= list(prerequisites),
                phi_weight   = phi_weight,
                metadata     = {"csid": csid, "query": component_name},
            )
            self._engine.enqueue_discovery(node)
            log.info("CRAWLER → CSID %s registered, queued for graph expansion.", csid)
            return str(csid)
        else:
            log.error("CRAWLER → failed to resolve '%s'. Will retry next c
