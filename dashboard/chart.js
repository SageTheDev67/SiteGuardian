export function drawLineChart(canvas, points) {
  const ctx = canvas.getContext("2d");
  const w = canvas.width = canvas.clientWidth * devicePixelRatio;
  const h = canvas.height = canvas.clientHeight * devicePixelRatio;

  ctx.clearRect(0, 0, w, h);

  const pad = 18 * devicePixelRatio;
  const innerW = w - pad * 2;
  const innerH = h - pad * 2;

  const ys = points.map(p => p.y);
  const minY = Math.min(...ys, 0);
  const maxY = Math.max(...ys, 1);

  const X = (i) => pad + (i / ((points.length - 1) || 1)) * innerW;
  const Y = (v) => {
    const t = (v - minY) / ((maxY - minY) || 1);
    return pad + (1 - t) * innerH;
  };

  ctx.lineWidth = 1 * devicePixelRatio;
  ctx.strokeStyle = "rgba(15,23,42,0.10)";
  for (let i = 0; i < 4; i++) {
    const y = pad + (i / 3) * innerH;
    ctx.beginPath();
    ctx.moveTo(pad, y);
    ctx.lineTo(pad + innerW, y);
    ctx.stroke();
  }

  ctx.strokeStyle = "rgba(15,23,42,0.85)";
  ctx.lineWidth = 2 * devicePixelRatio;
  ctx.beginPath();
  points.forEach((p, i) => {
    const x = X(i);
    const y = Y(p.y);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();

  ctx.fillStyle = "rgba(15,23,42,0.90)";
  for (let i = 0; i < points.length; i++) {
    const x = X(i);
    const y = Y(points[i].y);
    ctx.beginPath();
    ctx.arc(x, y, 2.5 * devicePixelRatio, 0, Math.PI * 2);
    ctx.fill();
  }
}
