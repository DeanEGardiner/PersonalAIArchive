import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  Search,
  X,
  RefreshCw,
  Plus,
  Minus,
  Maximize2,
  Tag,
  FileText,
  Bookmark,
  MessageSquare,
  Sparkles,
  ExternalLink,
  MessageSquarePlus,
  ChevronRight,
  Info,
  Calendar,
  Folder,
  Layers,
  Network
} from 'lucide-react';
import { api } from '../api';

export default function MindMapView({
  initialQuery = '',
  onNavigateToNote,
  onNavigateToChatWithContext,
  onNavigateToConversation
}) {
  const [searchQuery, setSearchQuery] = useState(initialQuery);
  const [activeQuery, setActiveQuery] = useState(initialQuery);
  const [graphData, setGraphData] = useState(null);
  const [availableTags, setAvailableTags] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [selectedNode, setSelectedNode] = useState(null);
  const [isInspectorOpen, setIsInspectorOpen] = useState(false);
  const [hoveredNode, setHoveredNode] = useState(null);

  const DRAWER_WIDTH = 380;
  const canvasRef = useRef(null);
  const animFrameRef = useRef(null);
  const cameraAnimationRef = useRef(null);
  const isInspectorOpenRef = useRef(isInspectorOpen);
  isInspectorOpenRef.current = isInspectorOpen;
  const selectedNodeRef = useRef(selectedNode);
  selectedNodeRef.current = selectedNode;

  const simulationRef = useRef({
    nodes: [],
    links: [],
    alpha: 1.0,
    transform: { x: 0, y: 0, scale: 1 },
    dragNode: null,
    dragStartPos: { x: 0, y: 0 },
    hasDragged: false,
    isPanning: false,
    panStart: { x: 0, y: 0 },
    mousePos: { x: 0, y: 0 }
  });

  // Smoothly center camera on a node in the visible canvas space
  const centerOnNode = useCallback((node, isDrawerVisible = isInspectorOpenRef.current, duration = 350) => {
    const canvas = canvasRef.current;
    if (!canvas || !node) return;
    const rect = canvas.parentElement.getBoundingClientRect();
    const width = rect.width;
    const height = rect.height;

    // Center in the visible viewport (accounting for the slide-out drawer)
    const targetCenterX = isDrawerVisible ? (width - DRAWER_WIDTH) / 2 : width / 2;
    const targetCenterY = height / 2;

    const sim = simulationRef.current;
    const currentScale = sim.transform.scale || 1;
    const targetX = targetCenterX - node.x * currentScale;
    const targetY = targetCenterY - node.y * currentScale;

    cameraAnimationRef.current = {
      startX: sim.transform.x,
      startY: sim.transform.y,
      targetX,
      targetY,
      startTime: performance.now(),
      duration
    };
  }, []);

  const handleCloseInspector = useCallback(() => {
    setIsInspectorOpen(false);
    const nodeToCenter = selectedNodeRef.current || simulationRef.current.nodes.find(n => n.isRoot);
    if (nodeToCenter) {
      centerOnNode(nodeToCenter, false, 320);
    }
  }, [centerOnNode]);

  // Load Graph Data
  const loadGraph = useCallback(async (queryTerm) => {
    setIsLoading(true);
    try {
      const data = await api.getMindMap(queryTerm, 45);
      setGraphData(data);
      if (data.availableTags) {
        setAvailableTags(data.availableTags);
      }

      // Initialize Simulation Nodes & Links
      const width = canvasRef.current ? canvasRef.current.width : 1000;
      const height = canvasRef.current ? canvasRef.current.height : 700;
      const centerX = width / 2;
      const centerY = height / 2;

      // Position nodes radially around center
      const nodes = (data.nodes || []).map((n, idx) => {
        let x = centerX;
        let y = centerY;
        if (!n.isRoot) {
          const angle = (idx / (data.nodes.length || 1)) * Math.PI * 2;
          const dist = n.type === 'tag' ? 140 + Math.random() * 40 : n.type === 'conversation' ? 170 + Math.random() * 50 : 220 + Math.random() * 90;
          x = centerX + Math.cos(angle) * dist;
          y = centerY + Math.sin(angle) * dist;
        }
        return {
          ...n,
          x,
          y,
          vx: (Math.random() - 0.5) * 2,
          vy: (Math.random() - 0.5) * 2,
          radius: n.size || 20
        };
      });

      const nodeIndexMap = new Map();
      nodes.forEach((n) => nodeIndexMap.set(n.id, n));

      const links = (data.links || [])
        .map((l) => ({
          ...l,
          sourceNode: nodeIndexMap.get(l.source),
          targetNode: nodeIndexMap.get(l.target)
        }))
        .filter((l) => l.sourceNode && l.targetNode);

      simulationRef.current.nodes = nodes;
      simulationRef.current.links = links;
      simulationRef.current.alpha = 1.0;
      simulationRef.current.transform = { x: 0, y: 0, scale: 1 };

      // Set root or primary node as initially selected
      const root = nodes.find((n) => n.isRoot);
      if (root) {
        setSelectedNode(root);
      }
    } catch (err) {
      console.error('Failed to load mind map:', err);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadGraph(activeQuery);
  }, [activeQuery, loadGraph]);

  // Handle Search Submission
  const handleSearchSubmit = (e) => {
    if (e) e.preventDefault();
    setActiveQuery(searchQuery.trim());
  };

  const handleClearSearch = () => {
    setSearchQuery('');
    setActiveQuery('');
  };

  const handleTagClick = (tagName) => {
    setSearchQuery(tagName);
    setActiveQuery(tagName);
  };

  // Canvas Force Physics & Rendering Loop
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');

    const resizeCanvas = () => {
      const rect = canvas.parentElement.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      canvas.width = rect.width * dpr;
      canvas.height = rect.height * dpr;
      canvas.style.width = `${rect.width}px`;
      canvas.style.height = `${rect.height}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };

    resizeCanvas();
    window.addEventListener('resize', resizeCanvas);

    let pulse = 0;

    const render = () => {
      const sim = simulationRef.current;
      const rect = canvas.parentElement.getBoundingClientRect();
      const width = rect.width;
      const height = rect.height;
      const centerX = width / 2;
      const centerY = height / 2;

      pulse += 0.03;

      // Camera Smooth Interpolation Step (re-centering in visible space)
      if (cameraAnimationRef.current) {
        const anim = cameraAnimationRef.current;
        const now = performance.now();
        const elapsed = now - anim.startTime;
        const progress = Math.min(1, elapsed / anim.duration);
        // Ease-out cubic: 1 - (1 - progress)^3
        const ease = 1 - Math.pow(1 - progress, 3);
        sim.transform.x = anim.startX + (anim.targetX - anim.startX) * ease;
        sim.transform.y = anim.startY + (anim.targetY - anim.startY) * ease;
        if (progress >= 1) {
          cameraAnimationRef.current = null;
        }
      }

      // Physics Step
      if (sim.alpha > 0.005) {
        sim.alpha *= 0.985;
        const nodes = sim.nodes;
        const links = sim.links;

        // 1. Repulsion between all nodes
        for (let i = 0; i < nodes.length; i++) {
          for (let j = i + 1; j < nodes.length; j++) {
            const a = nodes[i];
            const b = nodes[j];
            const dx = b.x - a.x;
            const dy = b.y - a.y;
            let dist = Math.sqrt(dx * dx + dy * dy) || 1;
            const minDist = (a.radius + b.radius) * 2.2;
            if (dist < 400) {
              const rep = ((minDist * minDist) / (dist * dist)) * 0.45 * sim.alpha;
              const fx = (dx / dist) * rep;
              const fy = (dy / dist) * rep;
              a.vx -= fx;
              a.vy -= fy;
              b.vx += fx;
              b.vy += fy;
            }
          }
        }

        // 2. Spring attraction along links
        for (const l of links) {
          const s = l.sourceNode;
          const t = l.targetNode;
          const dx = t.x - s.x;
          const dy = t.y - s.y;
          const dist = Math.sqrt(dx * dx + dy * dy) || 1;
          const targetDist = (l.type === 'root_tag' || l.type === 'query_tag') ? 140 : (l.type === 'root_conversation' || l.type === 'query_conversation' || l.type === 'tag_conversation') ? 135 : 110;
          const spring = (dist - targetDist) * 0.035 * sim.alpha * (l.weight || 1.0);
          const fx = (dx / dist) * spring;
          const fy = (dy / dist) * spring;
          if (!s.isRoot) {
            s.vx += fx;
            s.vy += fy;
          }
          if (!t.isRoot) {
            t.vx -= fx;
            t.vy -= fy;
          }
        }

        // 3. Center gravitational anchor
        for (const n of nodes) {
          if (n.isRoot) {
            n.x += (centerX - n.x) * 0.08;
            n.y += (centerY - n.y) * 0.08;
            n.vx = 0;
            n.vy = 0;
            continue;
          }
          n.vx += (centerX - n.x) * 0.0015 * sim.alpha;
          n.vy += (centerY - n.y) * 0.0015 * sim.alpha;
          n.vx *= 0.88;
          n.vy *= 0.88;
          n.x += n.vx;
          n.y += n.vy;
        }
      }

      // -------------------------------------------------------------
      // DRAW CANVAS
      // -------------------------------------------------------------
      ctx.clearRect(0, 0, width, height);
      ctx.save();

      // Pan & Zoom Transform
      ctx.translate(sim.transform.x, sim.transform.y);
      ctx.scale(sim.transform.scale, sim.transform.scale);

      // Draw Background Grid Dots
      const gridSize = 40;
      const startX = -sim.transform.x / sim.transform.scale;
      const startY = -sim.transform.y / sim.transform.scale;
      const endX = startX + width / sim.transform.scale;
      const endY = startY + height / sim.transform.scale;

      ctx.fillStyle = 'rgba(255, 255, 255, 0.035)';
      for (let gx = Math.floor(startX / gridSize) * gridSize; gx < endX; gx += gridSize) {
        for (let gy = Math.floor(startY / gridSize) * gridSize; gy < endY; gy += gridSize) {
          ctx.beginPath();
          ctx.arc(gx, gy, 1, 0, Math.PI * 2);
          ctx.fill();
        }
      }

      // Draw Links
      for (const l of sim.links) {
        const s = l.sourceNode;
        const t = l.targetNode;
        ctx.beginPath();
        ctx.moveTo(s.x, s.y);
        ctx.lineTo(t.x, t.y);

        let strokeColor = 'rgba(148, 163, 184, 0.22)';
        let lineWidth = 1.2;

        if (l.type === 'query_tag' || l.type === 'root_tag') {
          strokeColor = 'rgba(6, 182, 212, 0.45)';
          lineWidth = 2.0;
        } else if (l.type === 'tag_note') {
          strokeColor = 'rgba(236, 72, 153, 0.35)';
          lineWidth = 1.5;
        } else if (l.type === 'root_conversation' || l.type === 'query_conversation' || l.type === 'tag_conversation' || l.type === 'note_conversation') {
          strokeColor = 'rgba(139, 92, 246, 0.45)';
          lineWidth = 1.6;
        } else if (l.type === 'note_wiki') {
          strokeColor = 'rgba(245, 158, 11, 0.3)';
          lineWidth = 1.0;
        }

        ctx.strokeStyle = strokeColor;
        ctx.lineWidth = lineWidth;
        ctx.stroke();
      }

      // Draw Nodes
      for (const n of sim.nodes) {
        const isSelected = selectedNode?.id === n.id;
        const isHovered = hoveredNode?.id === n.id;
        const isCenter = n.isRoot;

        // Radiant Outer Glow for Center / Selected
        if (isCenter) {
          const glowRadius = n.radius + 8 + Math.sin(pulse) * 4;
          const grad = ctx.createRadialGradient(n.x, n.y, n.radius * 0.5, n.x, n.y, glowRadius);
          grad.addColorStop(0, 'rgba(168, 85, 247, 0.4)');
          grad.addColorStop(1, 'rgba(168, 85, 247, 0)');
          ctx.fillStyle = grad;
          ctx.beginPath();
          ctx.arc(n.x, n.y, glowRadius, 0, Math.PI * 2);
          ctx.fill();
        } else if (isSelected || isHovered) {
          let haloColor = 'rgba(236, 72, 153, 0.25)';
          if (n.type === 'tag') haloColor = 'rgba(6, 182, 212, 0.25)';
          else if (n.type === 'conversation') haloColor = 'rgba(139, 92, 246, 0.3)';
          else if (n.type === 'digest') haloColor = 'rgba(16, 185, 129, 0.25)';
          ctx.fillStyle = haloColor;
          ctx.beginPath();
          ctx.arc(n.x, n.y, n.radius + 6, 0, Math.PI * 2);
          ctx.fill();
        }

        // Main Node Body
        ctx.beginPath();
        ctx.arc(n.x, n.y, n.radius, 0, Math.PI * 2);

        // Fill color based on node category
        let fill = '#1e1b4b';
        let stroke = n.color || '#a855f7';

        if (n.type === 'query') {
          fill = '#4c1d95';
        } else if (n.type === 'tag') {
          fill = '#083344';
          stroke = '#06b6d4';
        } else if (n.type === 'note') {
          fill = '#31102e';
          stroke = '#ec4899';
        } else if (n.type === 'conversation') {
          fill = '#2e1065';
          stroke = '#8b5cf6';
        } else if (n.type === 'wikilink') {
          fill = '#2e1c0c';
          stroke = '#f59e0b';
        } else if (n.type === 'digest') {
          fill = '#062e24';
          stroke = '#10b981';
        }

        ctx.fillStyle = fill;
        ctx.fill();

        ctx.lineWidth = isSelected ? 3 : isHovered ? 2.5 : 1.5;
        ctx.strokeStyle = isSelected ? '#ffffff' : stroke;
        ctx.stroke();

        // Node Label
        ctx.font = isCenter ? 'bold 13px Inter, system-ui, sans-serif' : '11px Inter, system-ui, sans-serif';
        ctx.fillStyle = isSelected ? '#ffffff' : '#e2e8f0';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';

        // Draw node icon or short label
        const displayLabel = n.label.length > 20 ? n.label.slice(0, 18) + '...' : n.label;
        ctx.fillText(displayLabel, n.x, n.y + n.radius + 12);

        // If tag or conversation node, draw count badge
        if (n.type === 'tag' && n.count) {
          ctx.font = '9px Inter, system-ui, sans-serif';
          ctx.fillStyle = '#67e8f9';
          ctx.fillText(`${n.count} notes`, n.x, n.y + n.radius + 24);
        } else if (n.type === 'conversation' && n.msg_count) {
          ctx.font = '9px Inter, system-ui, sans-serif';
          ctx.fillStyle = '#c4b5fd';
          ctx.fillText(`${n.msg_count} msgs`, n.x, n.y + n.radius + 24);
        }
      }

      ctx.restore();
      animFrameRef.current = requestAnimationFrame(render);
    };

    animFrameRef.current = requestAnimationFrame(render);

    return () => {
      cancelAnimationFrame(animFrameRef.current);
      window.removeEventListener('resize', resizeCanvas);
    };
  }, [selectedNode, hoveredNode]);

  // Coordinate conversion helpers
  const getCanvasMousePos = (e) => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    const sim = simulationRef.current;
    const clientX = e.clientX - rect.left;
    const clientY = e.clientY - rect.top;
    const worldX = (clientX - sim.transform.x) / sim.transform.scale;
    const worldY = (clientY - sim.transform.y) / sim.transform.scale;
    return { screenX: clientX, screenY: clientY, worldX, worldY };
  };

  const findNodeAt = (worldX, worldY) => {
    const nodes = simulationRef.current.nodes;
    for (let i = nodes.length - 1; i >= 0; i--) {
      const n = nodes[i];
      const dx = worldX - n.x;
      const dy = worldY - n.y;
      if (dx * dx + dy * dy <= (n.radius + 6) * (n.radius + 6)) {
        return n;
      }
    }
    return null;
  };

  // Mouse Interactions
  const handleMouseDown = (e) => {
    if (e.button !== 0) return;
    const { screenX, screenY, worldX, worldY } = getCanvasMousePos(e);
    const hit = findNodeAt(worldX, worldY);

    if (hit) {
      simulationRef.current.dragNode = hit;
      simulationRef.current.dragStartPos = { x: screenX, y: screenY };
      simulationRef.current.hasDragged = false;
      simulationRef.current.alpha = 0.5;
      setSelectedNode(hit);
      setIsInspectorOpen(true);
      // Recenter node in the middle of remaining visible space
      centerOnNode(hit, true);
    } else {
      simulationRef.current.isPanning = true;
      cameraAnimationRef.current = null;
      simulationRef.current.panStart = {
        x: screenX - simulationRef.current.transform.x,
        y: screenY - simulationRef.current.transform.y
      };
    }
  };

  const handleMouseMove = (e) => {
    const { screenX, screenY, worldX, worldY } = getCanvasMousePos(e);
    const sim = simulationRef.current;

    if (sim.dragNode) {
      const dist = Math.hypot(screenX - (sim.dragStartPos?.x || 0), screenY - (sim.dragStartPos?.y || 0));
      if (dist > 5) {
        sim.hasDragged = true;
        cameraAnimationRef.current = null;
      }
      sim.dragNode.x = worldX;
      sim.dragNode.y = worldY;
      sim.alpha = 0.3;
    } else if (sim.isPanning) {
      cameraAnimationRef.current = null;
      sim.transform.x = screenX - sim.panStart.x;
      sim.transform.y = screenY - sim.panStart.y;
    } else {
      const hit = findNodeAt(worldX, worldY);
      setHoveredNode(hit);
    }
  };

  const handleMouseUp = () => {
    simulationRef.current.dragNode = null;
    simulationRef.current.isPanning = false;
  };

  const handleWheel = (e) => {
    e.preventDefault();
    cameraAnimationRef.current = null;
    const sim = simulationRef.current;
    const zoomFactor = e.deltaY < 0 ? 1.1 : 0.9;
    const newScale = Math.max(0.3, Math.min(3.0, sim.transform.scale * zoomFactor));

    const { screenX, screenY } = getCanvasMousePos(e);
    sim.transform.x = screenX - (screenX - sim.transform.x) * (newScale / sim.transform.scale);
    sim.transform.y = screenY - (screenY - sim.transform.y) * (newScale / sim.transform.scale);
    sim.transform.scale = newScale;
  };

  const handleDoubleClick = (e) => {
    const { worldX, worldY } = getCanvasMousePos(e);
    const hit = findNodeAt(worldX, worldY);
    if (hit) {
      const newQuery = hit.tagName || hit.name || hit.label.replace(/^#|\[\[|\]\]/g, '');
      setSearchQuery(newQuery);
      setActiveQuery(newQuery);
    }
  };

  // Zoom Controls
  const handleZoom = (direction) => {
    const sim = simulationRef.current;
    cameraAnimationRef.current = null;
    const factor = direction === 'in' ? 1.25 : 0.8;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const cx = isInspectorOpenRef.current ? (rect.width - DRAWER_WIDTH) / 2 : rect.width / 2;
    const cy = rect.height / 2;
    const newScale = Math.max(0.3, Math.min(3.0, sim.transform.scale * factor));
    sim.transform.x = cx - (cx - sim.transform.x) * (newScale / sim.transform.scale);
    sim.transform.y = cy - (cy - sim.transform.y) * (newScale / sim.transform.scale);
    sim.transform.scale = newScale;
  };

  const handleResetView = () => {
    const sim = simulationRef.current;
    cameraAnimationRef.current = null;
    sim.transform.scale = 1;
    sim.alpha = 0.8;
    const root = sim.nodes.find((n) => n.isRoot);
    if (root) {
      centerOnNode(root, isInspectorOpenRef.current, 300);
    } else {
      sim.transform = { x: 0, y: 0, scale: 1 };
    }
  };

  const handleReheatPhysics = () => {
    simulationRef.current.alpha = 1.0;
  };

  return (
    <div className="mindmap-container" style={{ display: 'flex', flexDirection: 'column', height: '100%', position: 'relative', overflow: 'hidden', background: '#0a0d14' }}>
      {/* Top Search & Filter Control Bar */}
      <div style={{
        padding: '16px 24px',
        background: 'rgba(15, 23, 42, 0.75)',
        backdropFilter: 'blur(16px)',
        borderBottom: '1px solid rgba(255, 255, 255, 0.08)',
        zIndex: 20,
        display: 'flex',
        flexDirection: 'column',
        gap: '12px'
      }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '16px' }}>
          {/* Search Input Box */}
          <form onSubmit={handleSearchSubmit} style={{ display: 'flex', alignItems: 'center', gap: '10px', flex: 1, maxWidth: '580px', position: 'relative' }}>
            <div style={{
              display: 'flex',
              alignItems: 'center',
              gap: '10px',
              background: 'rgba(30, 41, 59, 0.85)',
              border: '1px solid rgba(168, 85, 247, 0.35)',
              borderRadius: '10px',
              padding: '8px 14px',
              width: '100%',
              boxShadow: '0 4px 14px rgba(0, 0, 0, 0.25)'
            }}>
              <Search size={16} color="#c084fc" />
              <input
                type="text"
                placeholder="Search mind map concept, phrase, or tag (e.g. Rabobank, Mateus Asato)..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                style={{
                  background: 'transparent',
                  border: 'none',
                  color: '#fff',
                  fontSize: '13px',
                  outline: 'none',
                  width: '100%'
                }}
              />
              {searchQuery && (
                <button
                  type="button"
                  onClick={handleClearSearch}
                  style={{ background: 'transparent', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', display: 'flex', alignItems: 'center' }}
                >
                  <X size={14} />
                </button>
              )}
            </div>
            <button
              type="submit"
              className="btn-primary"
              style={{
                padding: '9px 18px',
                borderRadius: '10px',
                fontSize: '13px',
                fontWeight: 600,
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
                whiteSpace: 'nowrap'
              }}
            >
              <Sparkles size={14} />
              <span>Center Map</span>
            </button>
          </form>

          {/* Quick Graph Status Stats */}
          {graphData && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px', color: 'var(--text-muted)' }}>
              <span style={{ display: 'flex', alignItems: 'center', gap: '4px', background: 'rgba(255, 255, 255, 0.05)', padding: '6px 12px', borderRadius: '8px', border: '1px solid rgba(255, 255, 255, 0.08)' }}>
                <Network size={13} color="var(--accent-primary)" />
                <strong style={{ color: '#fff' }}>{graphData.stats?.nodesCount || 0}</strong> nodes
              </span>
              <span style={{ display: 'flex', alignItems: 'center', gap: '4px', background: 'rgba(255, 255, 255, 0.05)', padding: '6px 12px', borderRadius: '8px', border: '1px solid rgba(255, 255, 255, 0.08)' }}>
                <Tag size={13} color="#06b6d4" />
                <strong style={{ color: '#fff' }}>{graphData.stats?.tagsCount || 0}</strong> tags
              </span>
              <span style={{ display: 'flex', alignItems: 'center', gap: '4px', background: 'rgba(255, 255, 255, 0.05)', padding: '6px 12px', borderRadius: '8px', border: '1px solid rgba(255, 255, 255, 0.08)' }}>
                <FileText size={13} color="#ec4899" />
                <strong style={{ color: '#fff' }}>{graphData.stats?.notesCount || 0}</strong> notes
              </span>
              {graphData.stats?.conversationsCount > 0 && (
                <span style={{ display: 'flex', alignItems: 'center', gap: '4px', background: 'rgba(255, 255, 255, 0.05)', padding: '6px 12px', borderRadius: '8px', border: '1px solid rgba(255, 255, 255, 0.08)' }}>
                  <MessageSquare size={13} color="#8b5cf6" />
                  <strong style={{ color: '#fff' }}>{graphData.stats.conversationsCount}</strong> dialogues
                </span>
              )}
            </div>
          )}
        </div>

        {/* Quick Tag Suggestion Filter Bar */}
        {availableTags.length > 0 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', overflowX: 'auto', paddingBottom: '2px' }}>
            <span style={{ fontSize: '11px', color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: '4px', flexShrink: 0 }}>
              <Tag size={11} color="#06b6d4" /> Prioritized Vault Tags:
            </span>
            {availableTags.slice(0, 12).map((t) => {
              const isActive = activeQuery.toLowerCase() === t.name.toLowerCase();
              return (
                <button
                  key={t.name}
                  onClick={() => handleTagClick(t.name)}
                  style={{
                    background: isActive ? 'rgba(6, 182, 212, 0.25)' : 'rgba(30, 41, 59, 0.65)',
                    border: `1px solid ${isActive ? '#06b6d4' : 'rgba(255, 255, 255, 0.08)'}`,
                    color: isActive ? '#67e8f9' : '#cbd5e1',
                    borderRadius: '20px',
                    padding: '3px 10px',
                    fontSize: '11px',
                    fontWeight: 500,
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '4px',
                    flexShrink: 0,
                    transition: 'all 0.15s ease'
                  }}
                >
                  <span>#{t.name}</span>
                  <span style={{ fontSize: '10px', opacity: 0.6 }}>({t.count})</span>
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* Main Graph Viewport */}
      <div style={{ flex: 1, position: 'relative', overflow: 'hidden', cursor: hoveredNode ? 'pointer' : 'grab' }}>
        <canvas
          ref={canvasRef}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onWheel={handleWheel}
          onDoubleClick={handleDoubleClick}
          style={{ width: '100%', height: '100%', display: 'block' }}
        />

        {/* Floating Zoom / Simulation Controls */}
        <div style={{
          position: 'absolute',
          bottom: '24px',
          left: '24px',
          display: 'flex',
          flexDirection: 'column',
          gap: '8px',
          background: 'rgba(15, 23, 42, 0.75)',
          backdropFilter: 'blur(12px)',
          border: '1px solid rgba(255, 255, 255, 0.1)',
          borderRadius: '10px',
          padding: '6px',
          zIndex: 10
        }}>
          <button
            onClick={() => handleZoom('in')}
            title="Zoom In"
            style={{ background: 'transparent', border: 'none', color: '#fff', padding: '6px', cursor: 'pointer', borderRadius: '6px', display: 'flex' }}
          >
            <Plus size={16} />
          </button>
          <button
            onClick={() => handleZoom('out')}
            title="Zoom Out"
            style={{ background: 'transparent', border: 'none', color: '#fff', padding: '6px', cursor: 'pointer', borderRadius: '6px', display: 'flex' }}
          >
            <Minus size={16} />
          </button>
          <button
            onClick={handleResetView}
            title="Reset View"
            style={{ background: 'transparent', border: 'none', color: '#fff', padding: '6px', cursor: 'pointer', borderRadius: '6px', display: 'flex' }}
          >
            <Maximize2 size={16} />
          </button>
          <button
            onClick={handleReheatPhysics}
            title="Reheat Physics"
            style={{ background: 'transparent', border: 'none', color: '#fff', padding: '6px', cursor: 'pointer', borderRadius: '6px', display: 'flex' }}
          >
            <RefreshCw size={16} />
          </button>
        </div>

        {/* Instructions Helper Chip */}
        <div style={{
          position: 'absolute',
          bottom: '24px',
          left: '50%',
          transform: 'translateX(-50%)',
          background: 'rgba(15, 23, 42, 0.75)',
          backdropFilter: 'blur(12px)',
          border: '1px solid rgba(255, 255, 255, 0.08)',
          borderRadius: '20px',
          padding: '6px 16px',
          fontSize: '11px',
          color: 'var(--text-muted)',
          display: 'flex',
          alignItems: 'center',
          gap: '6px',
          pointerEvents: 'none'
        }}>
          <Info size={12} color="var(--accent-primary)" />
          <span>Double-click any node to re-center graph · Drag to pin · Scroll to zoom</span>
        </div>

        {/* Slide-Out Inspector Drawer */}
        {selectedNode && isInspectorOpen && (
          <div style={{
            position: 'absolute',
            top: 0,
            right: 0,
            width: '380px',
            height: '100%',
            background: 'rgba(15, 23, 42, 0.92)',
            backdropFilter: 'blur(20px)',
            borderLeft: '1px solid rgba(255, 255, 255, 0.12)',
            boxShadow: '-8px 0 32px rgba(0, 0, 0, 0.5)',
            zIndex: 30,
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
            animation: 'slideInRight 0.2s ease-out'
          }}>
            {/* Drawer Header */}
            <div style={{ padding: '20px 24px', borderBottom: '1px solid rgba(255, 255, 255, 0.08)', display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
              <div>
                <span style={{
                  fontSize: '10px',
                  fontWeight: 700,
                  textTransform: 'uppercase',
                  padding: '2px 8px',
                  borderRadius: '6px',
                  background: selectedNode.type === 'tag' ? 'rgba(6, 182, 212, 0.2)' 
                    : selectedNode.type === 'note' ? 'rgba(236, 72, 153, 0.2)' 
                    : selectedNode.type === 'conversation' ? 'rgba(139, 92, 246, 0.2)'
                    : selectedNode.type === 'digest' ? 'rgba(16, 185, 129, 0.2)'
                    : 'rgba(168, 85, 247, 0.2)',
                  color: selectedNode.type === 'tag' ? '#22d3ee' 
                    : selectedNode.type === 'note' ? '#f472b6' 
                    : selectedNode.type === 'conversation' ? '#c4b5fd'
                    : selectedNode.type === 'digest' ? '#6ee7b7'
                    : '#c084fc',
                  border: `1px solid ${selectedNode.color || 'var(--accent-primary)'}`
                }}>
                  {selectedNode.type === 'conversation' ? 'AI Conversation' : selectedNode.type}
                </span>
                <h3 style={{ fontSize: '18px', fontWeight: 700, color: '#fff', margin: '8px 0 4px 0', wordBreak: 'break-word' }}>
                  {selectedNode.label}
                </h3>
                {selectedNode.type === 'conversation' && (
                  <div style={{ fontSize: '11px', color: '#c4b5fd', display: 'flex', alignItems: 'center', gap: '4px', marginTop: '4px' }}>
                    <MessageSquare size={11} />
                    <span>{selectedNode.msg_count || 0} messages {selectedNode.model ? `· ${selectedNode.model}` : ''}</span>
                  </div>
                )}
                {selectedNode.rel_path && (
                  <div style={{ fontSize: '11px', color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: '4px' }}>
                    <Folder size={11} color="var(--accent-primary)" />
                    <span>{selectedNode.rel_path}</span>
                  </div>
                )}
                {selectedNode.date && (
                  <div style={{ fontSize: '11px', color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: '4px', marginTop: '2px' }}>
                    <Calendar size={11} />
                    <span>Created: {new Date(selectedNode.date).toLocaleDateString()}</span>
                  </div>
                )}
              </div>
              <button
                onClick={handleCloseInspector}
                style={{ background: 'transparent', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', padding: '4px' }}
                title="Close Inspector"
              >
                <X size={18} />
              </button>
            </div>

            {/* Drawer Body */}
            <div style={{ flex: 1, overflowY: 'auto', padding: '20px 24px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
              {/* Tags Section */}
              {selectedNode.tags && selectedNode.tags.length > 0 && (
                <div>
                  <span style={{ fontSize: '11px', fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', display: 'block', marginBottom: '8px' }}>
                    Connected Tags
                  </span>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                    {selectedNode.tags.map((t) => (
                      <button
                        key={t}
                        onClick={() => handleTagClick(t)}
                        style={{
                          background: 'rgba(6, 182, 212, 0.15)',
                          border: '1px solid rgba(6, 182, 212, 0.35)',
                          color: '#67e8f9',
                          borderRadius: '12px',
                          padding: '2px 8px',
                          fontSize: '11px',
                          cursor: 'pointer'
                        }}
                      >
                        #{t}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Preview Snippet */}
              <div>
                <span style={{ fontSize: '11px', fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', display: 'block', marginBottom: '8px' }}>
                  Excerpt Preview
                </span>
                <div style={{
                  padding: '12px 14px',
                  borderRadius: '8px',
                  background: 'rgba(255, 255, 255, 0.03)',
                  border: '1px solid rgba(255, 255, 255, 0.06)',
                  fontSize: '12px',
                  lineHeight: '1.6',
                  color: '#cbd5e1',
                  maxHeight: '260px',
                  overflowY: 'auto',
                  whiteSpace: 'pre-wrap'
                }}>
                  {selectedNode.preview || 'No excerpt available for this node.'}
                </div>
              </div>
            </div>

            {/* Drawer Action Buttons */}
            <div style={{ padding: '16px 24px', borderTop: '1px solid rgba(255, 255, 255, 0.08)', display: 'flex', flexDirection: 'column', gap: '8px' }}>
              <button
                className="btn-primary"
                onClick={() => {
                  const targetQuery = selectedNode.tagName || selectedNode.name || selectedNode.label.replace(/^#|\[\[|\]\]/g, '');
                  setSearchQuery(targetQuery);
                  setActiveQuery(targetQuery);
                }}
                style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px', fontSize: '13px' }}
              >
                <Sparkles size={14} />
                <span>Center Mind Map on "{selectedNode.label}"</span>
              </button>

              {selectedNode.type === 'conversation' && onNavigateToConversation && (
                <button
                  className="btn-primary"
                  onClick={() => onNavigateToConversation(selectedNode.conversationId)}
                  style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px', fontSize: '13px', background: '#7c3aed' }}
                >
                  <MessageSquare size={14} color="#fff" />
                  <span>Open Conversation in Chat</span>
                </button>
              )}

              {selectedNode.type === 'note' && onNavigateToNote && (
                <button
                  className="btn-secondary"
                  onClick={() => onNavigateToNote(selectedNode.noteId || selectedNode.rel_path, selectedNode.label || selectedNode.title)}
                  style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px', fontSize: '13px' }}
                >
                  <ExternalLink size={14} color="var(--accent-primary)" />
                  <span>Open in Vault Reader</span>
                </button>
              )}

              {selectedNode.type === 'wikilink' && onNavigateToNote && (
                <button
                  className="btn-secondary"
                  onClick={() => onNavigateToNote(selectedNode.name, selectedNode.name)}
                  style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px', fontSize: '13px' }}
                >
                  <ExternalLink size={14} color="var(--accent-primary)" />
                  <span>Find in Vault Reader</span>
                </button>
              )}

              {selectedNode.type === 'note' && onNavigateToChatWithContext && (
                <button
                  className="btn-secondary"
                  onClick={() => onNavigateToChatWithContext(selectedNode)}
                  style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px', fontSize: '13px' }}
                >
                  <MessageSquarePlus size={14} color="#06b6d4" />
                  <span>Ask AI About This Note</span>
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
