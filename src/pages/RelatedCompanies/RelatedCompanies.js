import React, { useState, useEffect, useRef } from 'react';
import * as d3 from 'd3';
import {
  Box,
  Grid,
  Typography,
  TextField,
  useTheme,
  Card,
  alpha
} from '@mui/material';
import { LoadingState, ErrorState } from '../../components/shared';
import polygonService from '../../services/polygonService';
import './RelatedCompanies.css';

function RelatedCompanies() {
  const theme = useTheme();
  const [ticker, setTicker] = useState('AAPL');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [selectedNode, setSelectedNode] = useState(null);
  const [graphData, setGraphData] = useState({ nodes: [], edges: [] });
  const svgRef = useRef();

  const fetchRelatedCompanies = async () => {
    try {
      setLoading(true);
      setError(null);
      
      const relatedCompanies = await polygonService.getRelatedTickers(ticker);
      
      // Transform data for D3
      const nodes = [{ id: ticker, label: ticker, group: 1 }];
      const edges = [];
      
      relatedCompanies.results.forEach((company, index) => {
        nodes.push({
          id: company.ticker,
          label: company.ticker,
          group: 2,
          relationship_score: company.relationship_score
        });
        
        edges.push({
          source: ticker,
          target: company.ticker,
          value: company.relationship_score
        });
      });

      setGraphData({ nodes, edges });
    } catch (err) {
      setError('Failed to fetch related companies data');
      console.error('Error:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchRelatedCompanies();
  }, [ticker]);

  useEffect(() => {
    if (!graphData.nodes.length || loading) return;

    const width = 800;
    const height = 600;

    // Clear previous graph
    d3.select(svgRef.current).selectAll("*").remove();

    const svg = d3.select(svgRef.current)
      .attr("width", width)
      .attr("height", height);

    // Create force simulation
    const simulation = d3.forceSimulation(graphData.nodes)
      .force("link", d3.forceLink(graphData.edges)
        .id(d => d.id)
        .distance(100))
      .force("charge", d3.forceManyBody().strength(-300))
      .force("center", d3.forceCenter(width / 2, height / 2));

    // Add links
    const link = svg.append("g")
      .selectAll("line")
      .data(graphData.edges)
      .join("line")
      .attr("stroke", theme.palette.divider)
      .attr("stroke-opacity", 0.6)
      .attr("stroke-width", d => Math.sqrt(d.value));

    // Add nodes
    const node = svg.append("g")
      .selectAll("circle")
      .data(graphData.nodes)
      .join("circle")
      .attr("r", d => d.group === 1 ? 8 : 6)
      .attr("fill", d => d.group === 1 ? theme.palette.error.main : theme.palette.primary.main)
      .call(drag(simulation));

    // Add labels
    const label = svg.append("g")
      .selectAll("text")
      .data(graphData.nodes)
      .join("text")
      .text(d => d.label)
      .attr("font-size", 12)
      .attr("dx", 12)
      .attr("dy", 4)
      .attr("fill", theme.palette.text.primary);

    // Add tooltips
    const tooltip = d3.select("body").append("div")
      .attr("class", "node-tooltip")
      .style("opacity", 0);

    node.on("mouseover", (event, d) => {
      tooltip.transition()
        .duration(200)
        .style("opacity", .9);
      tooltip.html(`
        <strong>${d.label}</strong><br/>
        ${d.group === 2 ? `Relationship: ${(d.relationship_score * 100).toFixed(1)}%` : 'Main Company'}
      `)
        .style("left", (event.pageX + 10) + "px")
        .style("top", (event.pageY - 28) + "px");
    })
    .on("mouseout", () => {
      tooltip.transition()
        .duration(500)
        .style("opacity", 0);
    });

    // Update positions
    simulation.on("tick", () => {
      link
        .attr("x1", d => d.source.x)
        .attr("y1", d => d.source.y)
        .attr("x2", d => d.target.x)
        .attr("y2", d => d.target.y);

      node
        .attr("cx", d => d.x)
        .attr("cy", d => d.y);

      label
        .attr("x", d => d.x)
        .attr("y", d => d.y);
    });

    // Cleanup
    return () => {
      simulation.stop();
    };
  }, [graphData, loading, theme]);

  // Drag functions
  const drag = (simulation) => {
    function dragstarted(event) {
      if (!event.active) simulation.alphaTarget(0.3).restart();
      event.subject.fx = event.subject.x;
      event.subject.fy = event.subject.y;
    }
    
    function dragged(event) {
      event.subject.fx = event.x;
      event.subject.fy = event.y;
    }
    
    function dragended(event) {
      if (!event.active) simulation.alphaTarget(0);
      event.subject.fx = null;
      event.subject.fy = null;
    }
    
    return d3.drag()
      .on("start", dragstarted)
      .on("drag", dragged)
      .on("end", dragended);
  };

  return (
    <Box className="related-companies-page" sx={{ p: 3 }}>
      <Grid container spacing={3}>
        <Grid item xs={12}>
          <Card sx={{ p: 3, mb: 3 }}>
            <Typography variant="h6" sx={{ mb: 2 }}>
              Related Companies Network
            </Typography>
            <TextField
              fullWidth
              label="Ticker Symbol"
              value={ticker}
              onChange={(e) => setTicker(e.target.value.toUpperCase())}
              placeholder="Enter ticker symbol"
              sx={{ maxWidth: 300 }}
            />
          </Card>
        </Grid>

        <Grid item xs={12}>
          {loading && <LoadingState />}
          {error && <ErrorState message={error} />}

          {!loading && !error && (
            <Card sx={{ p: 3 }}>
              <Box className="network-content">
                <Box className="network-container" sx={{ 
                  backgroundColor: theme.palette.background.paper,
                  borderRadius: 1,
                  overflow: 'hidden'
                }}>
                  <svg ref={svgRef}></svg>
                </Box>
                <Box className="network-legend" sx={{ 
                  display: 'flex',
                  gap: 2,
                  mt: 2,
                  justifyContent: 'center'
                }}>
                  <Box sx={{ 
                    display: 'flex',
                    alignItems: 'center',
                    gap: 1
                  }}>
                    <Box sx={{ 
                      width: 12,
                      height: 12,
                      borderRadius: '50%',
                      backgroundColor: theme.palette.error.main
                    }} />
                    <Typography>Main Company</Typography>
                  </Box>
                  <Box sx={{ 
                    display: 'flex',
                    alignItems: 'center',
                    gap: 1
                  }}>
                    <Box sx={{ 
                      width: 12,
                      height: 12,
                      borderRadius: '50%',
                      backgroundColor: theme.palette.primary.main
                    }} />
                    <Typography>Related Company</Typography>
                  </Box>
                </Box>
              </Box>
            </Card>
          )}
        </Grid>
      </Grid>
    </Box>
  );
}

export default RelatedCompanies; 