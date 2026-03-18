/*
 * ╔══════════════════════════════════════════════════════════════════════╗
 * ║  {/} QUANTUM CUBE — PERPETUAL LEARNING PATH ENGINE                  ║
 * ║  MODULE : ION_LearningPath_v2.cs                                     ║
 * ║  TARGET : Extinct Species Molecular Synthesis / Perpetual Curriculum ║
 * ║  STATUS : ACTIVE — ASYNC TASK-BASED LEARNING LOOP                   ║
 * ╚══════════════════════════════════════════════════════════════════════╝
 *
 * ARCHITECTURE:
 *   KnowledgeNode<T>      — Generic node with typed metadata + phi weight
 *   KnowledgeGraph        — DAG with Kahn topological sort + availability query
 *   MasteryTracker        — Thread-safe mastery store with entropy decay
 *   IPriorityStrategy     — Interface: pluggable priority formula
 *   UrgencyPriorityStrategy — Default: urgency × discovery_bonus / phi
 *   PerpetualLearningEngine — Async CancellationToken-driven tick loop
 *   EngineEventArgs       — Typed event data (C# EventHandler pattern)
 *   QuantumCubeOrchestrator — Domain wiring: Great Auk curriculum + ION events
 *
 * Requires: .NET 8+ (C# 12, top-level programs, primary constructors, collection
 *            expressions). No external NuGet packages needed.
 */

using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;

// ─── Namespace ────────────────────────────────────────────────────────────────
namespace QuantumCube.ION.LearningPath;

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 1 — DATA STRUCTURES
// ═════════════════════════════════════════════════════════════════════════════

/// <summary>
/// Immutable record representing one learnable unit of knowledge.
/// In the ION context: one molecular component of an extinct species.
/// </summary>
/// <typeparam name="TMeta">Type of the domain-specific metadata payload.</typeparam>
public sealed record KnowledgeNode<TMeta>(
    string       NodeId,
    string       Label,
    IReadOnlyList<string> Prerequisites,
    double       PhiWeight,
    TMeta        Metadata
) {
    public DateTimeOffset CreatedAt { get; } = DateTimeOffset.UtcNow;

    public override string ToString() =>
        $"[{NodeId}] {Label} (φ={PhiWeight:F2})";
}

// ─────────────────────────────────────────────────────────────────────────────

/// <summary>Discriminated-union-style status for each node in the graph.</summary>
public enum LearningStatus
{
    Locked,
    Available,
    Mastered,
}

// ─────────────────────────────────────────────────────────────────────────────

/// <summary>
/// Directed Acyclic Graph of KnowledgeNodes (untyped via object boxing for
/// heterogeneous metadata support).  All domain logic that needs typed metadata
/// should operate on strongly-typed nodes before inserting them.
/// </summary>
public sealed class KnowledgeGraph
{
    // Store nodes unboxed — metadata is accessed via the strongly-typed wrappers
    private readonly Dictionary<string, (string Label, IReadOnlyList<string> Prereqs, double Phi)>
        _nodes = [];

    private readonly object _lock = new();

    // ── Mutation ──────────────────────────────────────────────────────────────

    /// <summary>Add a node. All prerequisites must already exist.</summary>
    public KnowledgeGraph AddNode<TMeta>(KnowledgeNode<TMeta> node)
    {
        ArgumentException.ThrowIfNullOrEmpty(node.NodeId);
        if (node.PhiWeight <= 0)
            throw new ArgumentOutOfRangeException(nameof(node.PhiWeight), "Must be positive");

        lock (_lock)
        {
            foreach (var dep in node.Prerequisites)
            {
                if (!_nodes.ContainsKey(dep))
                    throw new KeyNotFoundException(
                        $"Prerequisite '{dep}' not found when adding '{node.NodeId}'");
            }
            _nodes[node.NodeId] = (node.Label, node.Prerequisites, node.PhiWeight);
        }
        return this;
    }

    // ── Queries ───────────────────────────────────────────────────────────────

    public bool ContainsNode(string nodeId)
    {
        lock (_lock) return _nodes.ContainsKey(nodeId);
    }

    public int Count { get { lock (_lock) return _nodes.Count; } }

    /// <summary>Returns node IDs whose prerequisites are all at or above threshold.</summary>
    public IReadOnlyList<string> AvailableNodeIds(
        IReadOnlyDictionary<string, double> masteryMap,
        double threshold)
    {
        lock (_lock)
        {
            return _nodes
                .Where(kvp => kvp.Value.Prereqs.All(dep =>
                    masteryMap.TryGetValue(dep, out var m) && m >= threshold))
                .Select(kvp => kvp.Key)
                .ToList();
        }
    }

    public double GetPhi(string nodeId)
    {
        lock (_lock) return _nodes.TryGetValue(nodeId, out var n) ? n.Phi : 1.0;
    }

    public string GetLabel(string nodeId)
    {
        lock (_lock) return _nodes.TryGetValue(nodeId, out var n) ? n.Label : nodeId;
    }

    /// <summary>Kahn's algorithm — returns node IDs in valid learning order.</summary>
    public IReadOnlyList<string> TopologicalSort()
    {
        lock (_lock)
        {
            var inDeg = _nodes.ToDictionary(kvp => kvp.Key, _ => 0);
            foreach (var node in _nodes.Values)
                foreach (var _ in node.Prereqs)
                    inDeg[_nodes.First(n => n.Value.Prereqs.Contains(node.Prereqs[0])).Key]++;

            // Correct in-degree computation
            var inDegree = _nodes.ToDictionary(kvp => kvp.Key, _ => 0);
            foreach (var (id, data) in _nodes)
                inDegree[id] = data.Prereqs.Count;

            var queue  = new Queue<string>(inDegree.Where(x => x.Value == 0).Select(x => x.Key));
            var result = new List<string>();

            while (queue.Count > 0)
            {
                var id = queue.Dequeue();
                result.Add(id);
                foreach (var (candidateId, candidateData) in _nodes)
                {
                    if (candidateData.Prereqs.Contains(id))
                    {
                        inDegree[candidateId]--;
                        if (inDegree[candidateId] == 0)
                            queue.Enqueue(candidateId);
                    }
                }
            }

            if (result.Count != _nodes.Count)
                throw new InvalidOperationException("Cycle detected — graph is not a DAG");

            return result.Select(id => $"[{id}] {_nodes[id].Label} (φ={_nodes[id].Phi:F2})").ToList();
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────

/// <summary>
/// Thread-safe mastery score store with exponential entropy decay.
///
///   mastery(t) = mastery(t₀) × e^(−λ × Δt_seconds)
///
/// Default: 72-hour half-life (λ = ln2 / 259200 ≈ 2.67 × 10⁻⁶ s⁻¹)
/// </summary>
public sealed class MasteryTracker
{
    private record struct Record(double Score, DateTimeOffset LastUpdated, int StudyCount);

    private readonly ConcurrentDictionary<string, Record> _records = new();
    private readonly double _lambda;        // decay constant (per second)
    private readonly double _floor;         // minimum mastery (knowledge never reaches 0)

    public MasteryTracker(double halfLifeHours = 72.0, double masteryFloor = 0.05)
    {
        _lambda = Math.Log(2) / (halfLifeHours * 3600);
        _floor  = masteryFloor;
    }

    /// <summary>
    /// Record a study session.  Returns the new (post-gain) mastery score.
    /// Gain formula: diminishing returns scaled by session length / phi complexity.
    /// </summary>
    public double RecordLearning(string nodeId, double phiWeight, double sessionMinutes)
    {
        double updated = 0;
        _records.AddOrUpdate(
            nodeId,
            _ => {
                // First-ever study session
                double gain = sessionMinutes / (sessionMinutes + phiWeight * 8.0);
                updated = Math.Min(1.0, gain);
                return new Record(updated, DateTimeOffset.UtcNow, 1);
            },
            (_, existing) => {
                double current = LiveMastery(existing);
                double gain    = (1.0 - current) * (sessionMinutes / (sessionMinutes + phiWeight * 8.0));
                updated = Math.Min(1.0, current + gain);
                return new Record(updated, DateTimeOffset.UtcNow, existing.StudyCount + 1);
            });
        return updated;
    }

    public double GetMastery(string nodeId) =>
        _records.TryGetValue(nodeId, out var r) ? LiveMastery(r) : 0.0;

    public int StudyCount(string nodeId) =>
        _records.TryGetValue(nodeId, out var r) ? r.StudyCount : 0;

    /// <summary>Returns a snapshot of all current (decay-adjusted) scores.</summary>
    public IReadOnlyDictionary<string, double> Snapshot() =>
        _records.ToDictionary(kvp => kvp.Key, kvp => LiveMastery(kvp.Value));

    // ── private ───────────────────────────────────────────────────────────────

    private double LiveMastery(Record record)
    {
        double elapsedSeconds = (DateTimeOffset.UtcNow - record.LastUpdated).TotalSeconds;
        double decayed        = record.Score * Math.Exp(-_lambda * elapsedSeconds);
        return Math.Max(_floor, decayed);
    }
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 2 — PRIORITY STRATEGY (OPEN/CLOSED PRINCIPLE)
// ═════════════════════════════════════════════════════════════════════════════

/// <summary>Pluggable interface for computing node priority scores.</summary>
public interface IPriorityStrategy
{
    /// <summary>Higher return value ⟹ study this node sooner.</summary>
    double Compute(
        string                          nodeId,
        double                          phiWeight,
        IReadOnlyDictionary<string, double> masteryMap,
        MasteryTracker                  tracker);
}

// ─────────────────────────────────────────────────────────────────────────────

/// <summary>
/// Default strategy:
///   urgency        = 1 − mastery
///   discoveryBonus = 2.0 if never studied, else 1.0
///   phiPenalty     = 1 / phiWeight
///   priority       = urgency × discoveryBonus × phiPenalty
/// </summary>
public sealed class UrgencyPriorityStrategy : IPriorityStrategy
{
    public double Compute(
        string nodeId,
        double phiWeight,
        IReadOnlyDictionary<string, double> masteryMap,
        MasteryTracker tracker)
    {
        double mastery        = masteryMap.TryGetValue(nodeId, out var m) ? m : 0.0;
        double urgency        = 1.0 - mastery;
        double discoveryBonus = tracker.StudyCount(nodeId) == 0 ? 2.0 : 1.0;
        double phiPenalty     = 1.0 / phiWeight;
        return urgency * discoveryBonus * phiPenalty;
    }
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 3 — EVENT ARGS (TYPED EVENTS)
// ═════════════════════════════════════════════════════════════════════════════

public sealed class TickEventArgs(int cycle, string selected, double priority, double newMastery, double energyGained, double energyPool)
    : EventArgs
{
    public int    Cycle        { get; } = cycle;
    public string Selected     { get; } = selected;
    public double Priority     { get; } = priority;
    public double NewMastery   { get; } = newMastery;
    public double EnergyGained { get; } = energyGained;
    public double EnergyPool   { get; } = energyPool;
}

public sealed class MasteredEventArgs(string nodeId, string label, double mastery) : EventArgs
{
    public string NodeId  { get; } = nodeId;
    public string Label   { get; } = label;
    public double Mastery { get; } = mastery;
}

public sealed class ExpandedEventArgs(string newNode) : EventArgs
{
    public string NewNode { get; } = newNode;
}

public sealed class CompleteEventArgs(int totalCycles, double energyPool, IReadOnlyList<string> mastered)
    : EventArgs
{
    public int                  TotalCycles { get; } = totalCycles;
    public double               EnergyPool  { get; } = energyPool;
    public IReadOnlyList<string> Mastered   { get; } = mastered;
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 4 — THE PERPETUAL ENGINE
// ═════════════════════════════════════════════════════════════════════════════

/// <summary>
/// Async CancellationToken-driven perpetual learning loop.
///
/// On every tick:
///   1. Apply mastery decay (implicit via MasteryTracker.Snapshot)
///   2. Get all available (unlocked) nodes
///   3. Score with the injected IPriorityStrategy
///   4. Select highest-priority node and simulate a study session
///   5. Raise typed C# events (Tick, Mastered, Expanded, Complete)
///   6. Attempt dynamic graph expansion from the discovery queue
///   7. Await TickInterval and repeat
/// </summary>
public sealed class PerpetualLearningEngine
{
    // ── Configuration ─────────────────────────────────────────────────────────
    public TimeSpan TickInterval     { get; init; } = TimeSpan.FromSeconds(3);
    public double   SessionMinutes   { get; init; } = 30.0;
    public double   MasteryThreshold { get; init; } = 0.82;
    public int      MaxCycles        { get; init; } = 0;    // 0 = infinite
    public bool     AutoExpand       { get; init; } = true;

    // ── Events ────────────────────────────────────────────────────────────────
    public event EventHandler<TickEventArgs>?     OnTick;
    public event EventHandler<MasteredEventArgs>? OnMastered;
    public event EventHandler<ExpandedEventArgs>? OnExpanded;
    public event EventHandler<CompleteEventArgs>? OnComplete;
    public event EventHandler<Exception>?         OnError;

    // ── State ─────────────────────────────────────────────────────────────────
    public int    Cycle      { get; private set; }
    public double EnergyPool { get; private set; }

    private readonly KnowledgeGraph   _graph;
    private readonly MasteryTracker   _tracker;
    private readonly IPriorityStrategy _strategy;
    private readonly HashSet<string>  _masteredSet = [];
    private readonly ConcurrentQueue<(string Id, string Label, IReadOnlyList<string> Prereqs, double Phi)>
        _discoveryQueue = new();

    // ─────────────────────────────────────────────────────────────────────────

    public PerpetualLearningEngine(
        KnowledgeGraph    graph,
        MasteryTracker    tracker,
        IPriorityStrategy strategy)
    {
        _graph    = graph;
        _tracker  = tracker;
        _strategy = strategy;
    }

    /// <summary>
    /// Enqueue a raw node descriptor for dynamic graph expansion.
    /// It will be added when all its prerequisites are mastered.
    /// </summary>
    public void EnqueueDiscovery(string id, string label, IReadOnlyList<string> prereqs, double phi) =>
        _discoveryQueue.Enqueue((id, label, prereqs, phi));

    // ── Public start ──────────────────────────────────────────────────────────

    /// <summary>
    /// Starts the perpetual loop.  Returns a Task that completes when the engine
    /// stops (via cancellation or MaxCycles reached).
    /// </summary>
    public async Task RunAsync(CancellationToken cancellationToken = default)
    {
        Console.WriteLine("[ION ENGINE] Perpetual Learning Path ONLINE.");

        while (!cancellationToken.IsCancellationRequested)
        {
            try
            {
                await TickAsync(cancellationToken).ConfigureAwait(false);
            }
            catch (OperationCanceledException) { break; }
            catch (Exception ex)
            {
                OnError?.Invoke(this, ex);
                Console.Error.WriteLine($"[ION ERROR] {ex.Message}");
            }

            if (MaxCycles > 0 && Cycle >= MaxCycles)
            {
                Console.WriteLine($"[ION ENGINE] Max cycles ({MaxCycles}) reached. Stopping.");
                break;
            }

            await Task.Delay(TickInterval, cancellationToken).ConfigureAwait(false);
        }
    }

    // ── Core tick ─────────────────────────────────────────────────────────────

    private async Task TickAsync(CancellationToken ct)
    {
        Cycle++;
        ct.ThrowIfCancellationRequested();

        var masteryMap = _tracker.Snapshot();

        // ── 1. Attempt graph expansion ───────────────────────────────────────
        AttemptGraphExpansion(masteryMap);

        // ── 2. Identify available (not-yet-mastered, unlocked) nodes ─────────
        var availableIds = _graph.AvailableNodeIds(masteryMap, MasteryThreshold)
            .Where(id => !_masteredSet.Contains(id) &&
                         masteryMap.GetValueOrDefault(id, 0.0) < MasteryThreshold)
            .ToList();

        if (availableIds.Count == 0)
        {
            if (_discoveryQueue.IsEmpty)
            {
                var args = new CompleteEventArgs(Cycle, EnergyPool, [.. _masteredSet]);
                OnComplete?.Invoke(this, args);
                if (!AutoExpand)
                {
                    Console.WriteLine("[ION ENGINE] All nodes mastered and auto-expand disabled. Stopping.");
                    return;
                }
            }
            return;
        }

        // ── 3. Score and select best node ────────────────────────────────────
        var (selectedId, topPriority) = availableIds
            .Select(id => (id, priority: _strategy.Compute(id, _graph.GetPhi(id), masteryMap, _tracker)))
            .MaxBy(x => x.priority);

        double phi   = _graph.GetPhi(selectedId);
        string label = _graph.GetLabel(selectedId);

        // ── 4. Study session (async to allow await in real implementations) ───
        double newMastery = await Task.Run(() =>
            _tracker.RecordLearning(selectedId, phi, SessionMinutes), ct
        ).ConfigureAwait(false);

        // ── 5. Harvest energy ────────────────────────────────────────────────
        double energyGained = HarvestEnergy(phi, SessionMinutes);
        EnergyPool         += energyGained;

        // ── 6. Raise Tick event ───────────────────────────────────────────────
        OnTick?.Invoke(this, new TickEventArgs(
            Cycle, $"[{selectedId}] {label} (φ={phi:F2})",
            Math.Round(topPriority, 4), Math.Round(newMastery, 4),
            Math.Round(energyGained, 4), Math.Round(EnergyPool, 4)));

        // ── 7. Mastery threshold check ────────────────────────────────────────
        if (newMastery >= MasteryThreshold && _masteredSet.Add(selectedId))
        {
            OnMastered?.Invoke(this, new MasteredEventArgs(selectedId, label, newMastery));
        }
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    private void AttemptGraphExpansion(IReadOnlyDictionary<string, double> masteryMap)
    {
        var remaining = new List<(string Id, string Label, IReadOnlyList<string> Prereqs, double Phi)>();
        while (_discoveryQueue.TryDequeue(out var candidate))
        {
            bool prereqsMet = candidate.Prereqs.All(dep =>
                masteryMap.TryGetValue(dep, out var m) && m >= MasteryThreshold);

            if (prereqsMet)
            {
                try
                {
                    _graph.AddNode(new KnowledgeNode<object?>(
                        candidate.Id, candidate.Label, candidate.Prereqs,
                        candidate.Phi, null));
                    OnExpanded?.Invoke(this, new ExpandedEventArgs(
                        $"[{candidate.Id}] {candidate.Label} (φ={candidate.Phi:F2})"));
                }
                catch (Exception ex)
                {
                    // Node already exists or prereq issue — log and skip
                    Console.Error.WriteLine($"[ION EXPAND ERROR] {ex.Message}");
                }
            }
            else
            {
                remaining.Add(candidate);
            }
        }
        // Re
