export function drawLineChart(canvas, points) {
  const ctx = canvas.getContext("2d");
  const w = canvas.width = canvas.clientWidth;
  const h = canvas.height;

  ctx.clearRect(0, 0, w, h);

  const pad = 10;
  const innerW = w - pad * 2;
  const innerH = h - pad * 2;

  const xs = points.map(p => p.x);
  const ys = points.map(p => p.y);

  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const rangeY = Math.max(1, maxY - minY);

  // grid
  ctx.globalAlpha = 0.25;
  ctx.lineWidth = 1;

  for (let i = 0; i <= 4; i++) {
    const y = pad + (innerH * i) / 4;
    ctx.beginPath();
    ctx.moveTo(pad, y);
    ctx.lineTo(pad + innerW, y);
    ctx.strokeStyle = "rgba(255,255,255,0.18)";
    ctx.stroke();
  }

  ctx.globalAlpha = 1;

  // convert points to pixels
  const px = points.map((p, i) => {
    const x = pad + (innerW * i) / Math.max(1, points.length - 1);
    const y = pad + innerH - ((p.y - minY) / rangeY) * innerH;
    return { x, y };
  });

  // build path
  const path = new Path2D();
  px.forEach((p, i) => {
    if (i === 0) path.moveTo(p.x, p.y);
    else path.lineTo(p.x, p.y);
  });

  // draw glow under line
  ctx.save();
  ctx.lineWidth = 6;
  ctx.strokeStyle = "rgba(99,102,241,0.35)";
  ctx.shadowBlur = 18;
  ctx.shadowColor = "rgba(99,102,241,0.45)";
  ctx.stroke(path);
  ctx.restore();

  // animate line draw
  const totalLen = approximateLength(px);
  const start = performance.now();
  const duration = 320;

  function frame(t) {
    const k = Math.min(1, (t - start) / duration);

    ctx.clearRect(0, 0, w, h);

    // redraw grid
    ctx.globalAlpha = 0.25;
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const y = pad + (innerH * i) / 4;
      ctx.beginPath();
      ctx.moveTo(pad, y);
      ctx.lineTo(pad + innerW, y);
      ctx.strokeStyle = "rgba(255,255,255,0.18)";
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    // glow
    ctx.save();
    ctx.lineWidth = 6;
    ctx.strokeStyle = "rgba(99,102,241,0.35)";
    ctx.shadowBlur = 18;
    ctx.shadowColor = "rgba(99,102,241,0.45)";
    ctx.stroke(path);
    ctx.restore();

    // main line
    ctx.save();
    ctx.lineWidth = 2;
    ctx.strokeStyle = "rgba(231,234,243,0.95)";
    ctx.setLineDash([totalLen, totalLen]);
    ctx.lineDashOffset = (1 - k) * totalLen;
    ctx.stroke(path);
    ctx.restore();

    // points
    ctx.save();
    ctx.fillStyle = "rgba(231,234,243,0.9)";
    for (const p of px) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, 2.2, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();

    if (k < 1) requestAnimationFrame(frame);
  }

  requestAnimationFrame(frame);
}

function approximateLength(points) {
  let len = 0;
  for (let i = 1; i < points.length; i++) {
    const dx = points[i].x - points[i - 1].x;
    const dy = points[i].y - points[i - 1].y;
    len += Math.hypot(dx, dy);
  }
  return Math.max(1, len);
}
