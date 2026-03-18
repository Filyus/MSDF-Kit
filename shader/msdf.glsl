// shader/msdf.glsl — Reference MTSDF shader for MSDF-Kit
//
// Usage: Bind the packed MTSDF atlas as u_msdfAtlas (sampler2D),
//        set u_pxRange to the pxRange used during generation (typically 4.0).
//
// Requires: GL_OES_standard_derivatives (for fwidth)

#ifdef GL_OES_standard_derivatives
#extension GL_OES_standard_derivatives : enable
#endif

precision mediump float;

uniform sampler2D u_msdfAtlas;
uniform float u_pxRange;  // = pxRange from MsdfConfig (typically 4.0)

// Median of three — core MSDF operation
float median(float r, float g, float b) {
    return max(min(r, g), min(max(r, g), b));
}

// Compute SDF alpha from MTSDF texture sample.
// uv      — texture coordinates within the glyph/icon region
// texSize — atlas dimensions in pixels (vec2(width, height))
float msdfAlpha(vec2 uv, vec2 texSize) {
    vec4 mtsdf = texture2D(u_msdfAtlas, uv);

    // MSDF channels (RGB) → median → distance
    float msdfDist = median(mtsdf.r, mtsdf.g, mtsdf.b);

    // True SDF in alpha channel (for shadows, outlines, etc.)
    // float trueDist = mtsdf.a;

    // Pixel-space signed distance
    float sd = (msdfDist - 0.5) * u_pxRange;

    // Antialiasing via fwidth (screen-space derivative)
    float screenPxDist = sd / fwidth(sd);
    float alpha = clamp(screenPxDist + 0.5, 0.0, 1.0);

    return alpha;
}

// Example fragment shader usage:
//
// varying vec2 v_uv;            // glyph UV in atlas space
// uniform vec3 u_textColor;
// uniform vec2 u_atlasSize;     // vec2(atlas.width, atlas.height)
//
// void main() {
//     float a = msdfAlpha(v_uv, u_atlasSize);
//     gl_FragColor = vec4(u_textColor, a);
// }
