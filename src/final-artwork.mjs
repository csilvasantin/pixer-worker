// Delivery context is separate from the subject requested by the person.
// A screen may be an intentional subject; an advertising canvas is not a mockup by default.
export function finalArtworkPrompt(prompt,{video=false}={}){
 const brief=String(prompt||'').trim();
 return `${brief}\n\nDelivery: return the finished ${video?'video':'image'} itself, filling the whole requested canvas edge to edge. Do not present the artwork inside a photographed screen, billboard, frame, exhibition stand, device bezel or poster mockup. A destination such as retail screens, digital signage or "para pantalla 9:16" describes where this asset will play, not an object to photograph. If the creative request explicitly asks for a mockup or photographed installation, or explicitly depicts a screen, billboard, frame or device as the scene subject or the product itself, preserve that requested subject; do not add another display or frame around the final canvas.`;
}
