#include <emscripten.h>
#include <cstdlib>
#include <cstring>
#include <vector>
#include <unordered_map>

#include <msdfgen.h>
#include <ext/import-font.h>
#include <ext/import-svg.h>
#include <core/edge-coloring.h>
#include <core/rasterization.h>

#include "svg_shape.h"

#ifdef MSDF_KIT_HARFBUZZ
#include <hb.h>
#endif

// ============================================================
// Internal state
// ============================================================

static msdfgen::FreetypeHandle *g_ftLibrary = nullptr;

static std::unordered_map<int, msdfgen::FontHandle *> g_fonts;
static int g_nextFontHandle = 1;

static std::unordered_map<int, msdfgen::Shape *> g_shapes;
static int g_nextShapeHandle = 1;

#ifdef MSDF_KIT_HARFBUZZ
static std::unordered_map<int, hb_font_t *> g_hbFonts;
#endif

static int g_lastBitmapW = 0;
static int g_lastBitmapH = 0;

// ============================================================
// Exported C functions
// ============================================================

extern "C" {

EMSCRIPTEN_KEEPALIVE
void init() {
    if (!g_ftLibrary) {
        g_ftLibrary = msdfgen::initializeFreetype();
    }
}

// === Fonts ===

EMSCRIPTEN_KEEPALIVE
int loadFont(const uint8_t *data, int length) {
    if (!g_ftLibrary) return -1;

    msdfgen::FontHandle *font = msdfgen::loadFontData(
        g_ftLibrary, reinterpret_cast<const msdfgen::byte *>(data), length);
    if (!font) return -1;

    int handle = g_nextFontHandle++;
    g_fonts[handle] = font;

#ifdef MSDF_KIT_HARFBUZZ
    {
        hb_blob_t *blob = hb_blob_create(
            reinterpret_cast<const char *>(data), length,
            HB_MEMORY_MODE_DUPLICATE, nullptr, nullptr);
        hb_face_t *face = hb_face_create(blob, 0);
        hb_blob_destroy(blob);
        hb_font_t *hbFont = hb_font_create(face);
        hb_face_destroy(face);
        g_hbFonts[handle] = hbFont;
    }
#endif

    return handle;
}

EMSCRIPTEN_KEEPALIVE
int shapeFromGlyph(int fontHandle, int codepoint) {
    auto it = g_fonts.find(fontHandle);
    if (it == g_fonts.end()) return -1;

    auto *shape = new msdfgen::Shape();
    double advance = 0;
    if (!msdfgen::loadGlyph(*shape, it->second,
                            static_cast<msdfgen::unicode_t>(codepoint),
                            msdfgen::FONT_SCALING_EM_NORMALIZED, &advance)) {
        delete shape;
        return -1;
    }

    shape->normalize();

    int handle = g_nextShapeHandle++;
    g_shapes[handle] = shape;
    return handle;
}

EMSCRIPTEN_KEEPALIVE
void getGlyphMetrics(int fontHandle, int codepoint,
                     double *advance, double *left, double *bottom,
                     double *right, double *top) {
    auto it = g_fonts.find(fontHandle);
    if (it == g_fonts.end()) return;

    msdfgen::Shape shape;
    double adv = 0;
    if (!msdfgen::loadGlyph(shape, it->second,
                            static_cast<msdfgen::unicode_t>(codepoint),
                            msdfgen::FONT_SCALING_EM_NORMALIZED, &adv))
        return;

    if (advance) *advance = adv;

    msdfgen::Shape::Bounds bounds = shape.getBounds();
    if (left)   *left   = bounds.l;
    if (bottom) *bottom = bounds.b;
    if (right)  *right  = bounds.r;
    if (top)    *top    = bounds.t;
}

EMSCRIPTEN_KEEPALIVE
void getFontMetrics(int fontHandle,
                    double *ascender, double *descender,
                    double *lineHeight, double *unitsPerEm) {
    auto it = g_fonts.find(fontHandle);
    if (it == g_fonts.end()) return;

    msdfgen::FontMetrics metrics = {};
    if (!msdfgen::getFontMetrics(metrics, it->second,
                                 msdfgen::FONT_SCALING_EM_NORMALIZED))
        return;

    if (ascender)   *ascender   = metrics.ascenderY;
    if (descender)  *descender  = metrics.descenderY;
    if (lineHeight) *lineHeight = metrics.lineHeight;
    if (unitsPerEm) *unitsPerEm = metrics.emSize;
}

EMSCRIPTEN_KEEPALIVE
double getKerning(int fontHandle, int cp1, int cp2) {
    auto it = g_fonts.find(fontHandle);
    if (it == g_fonts.end()) return 0;

    double kern = 0;
    msdfgen::getKerning(kern, it->second,
                        static_cast<msdfgen::unicode_t>(cp1),
                        static_cast<msdfgen::unicode_t>(cp2),
                        msdfgen::FONT_SCALING_EM_NORMALIZED);
    return kern;
}

// === Glyph by index ===

EMSCRIPTEN_KEEPALIVE
int shapeFromGlyphId(int fontHandle, int glyphId) {
    auto it = g_fonts.find(fontHandle);
    if (it == g_fonts.end()) return -1;

    auto *shape = new msdfgen::Shape();
    double advance = 0;
    if (!msdfgen::loadGlyph(*shape, it->second,
                            msdfgen::GlyphIndex(static_cast<unsigned>(glyphId)),
                            msdfgen::FONT_SCALING_EM_NORMALIZED, &advance)) {
        delete shape;
        return -1;
    }

    shape->normalize();

    int handle = g_nextShapeHandle++;
    g_shapes[handle] = shape;
    return handle;
}

#ifdef MSDF_KIT_HARFBUZZ

// layoutText returns a malloc'd float array with 6 floats per glyph:
//   [glyphId, xOffset, yOffset, xAdvance, yAdvance, cluster]
// Positions are EM-normalised (same scale as msdfgen FONT_SCALING_EM_NORMALIZED).
// cluster is the byte offset of the source character in the input UTF-8 string.
// Caller must free() the result. outCount receives the glyph count.
EMSCRIPTEN_KEEPALIVE
float *layoutText(int fontHandle, const char *text, int *outCount) {
    auto it = g_hbFonts.find(fontHandle);
    if (it == g_hbFonts.end()) return nullptr;

    hb_font_t *hbFont = it->second;
    unsigned upem = hb_face_get_upem(hb_font_get_face(hbFont));
    float scale = upem > 0 ? 1.0f / static_cast<float>(upem) : 1.0f;

    hb_buffer_t *buf = hb_buffer_create();
    hb_buffer_add_utf8(buf, text, -1, 0, -1);
    hb_buffer_guess_segment_properties(buf);
    hb_shape(hbFont, buf, nullptr, 0);

    unsigned glyphCount = 0;
    hb_glyph_info_t     *infos = hb_buffer_get_glyph_infos(buf, &glyphCount);
    hb_glyph_position_t *poses = hb_buffer_get_glyph_positions(buf, &glyphCount);

    float *output = static_cast<float *>(malloc(glyphCount * 6 * sizeof(float)));
    if (!output) {
        hb_buffer_destroy(buf);
        return nullptr;
    }

    for (unsigned i = 0; i < glyphCount; ++i) {
        float *g = output + i * 6;
        g[0] = static_cast<float>(infos[i].codepoint); // glyph ID (post-shaping)
        g[1] = static_cast<float>(poses[i].x_offset)  * scale;
        g[2] = static_cast<float>(poses[i].y_offset)  * scale;
        g[3] = static_cast<float>(poses[i].x_advance) * scale;
        g[4] = static_cast<float>(poses[i].y_advance) * scale;
        g[5] = static_cast<float>(infos[i].cluster);  // byte offset of source char
    }

    if (outCount) *outCount = static_cast<int>(glyphCount);
    hb_buffer_destroy(buf);
    return output;
}

#endif // MSDF_KIT_HARFBUZZ

// === SVG ===

EMSCRIPTEN_KEEPALIVE
int shapeFromSvgPath(const char *pathData, double viewBoxW, double viewBoxH) {
    auto *shape = new msdfgen::Shape();
    if (!msdfkit::shapeFromSvgPathData(*shape, pathData, viewBoxW, viewBoxH)) {
        delete shape;
        return -1;
    }

    int handle = g_nextShapeHandle++;
    g_shapes[handle] = shape;
    return handle;
}

EMSCRIPTEN_KEEPALIVE
void getShapeBounds(int shapeHandle,
                    double *left, double *bottom,
                    double *right, double *top) {
    auto it = g_shapes.find(shapeHandle);
    if (it == g_shapes.end()) return;

    msdfgen::Shape::Bounds bounds = it->second->getBounds();
    if (left)   *left   = bounds.l;
    if (bottom) *bottom = bounds.b;
    if (right)  *right  = bounds.r;
    if (top)    *top    = bounds.t;
}

// === Generation ===
// sdfMode: 0 = SDF (1ch), 1 = PSDF (1ch), 2 = MSDF (3ch), 3 = MTSDF (4ch)

EMSCRIPTEN_KEEPALIVE
float *generateMtsdf(int shapeHandle, int width, int height,
                     double pxRange, double angleThreshold,
                     int coloringMode, int sdfMode) {
    auto it = g_shapes.find(shapeHandle);
    if (it == g_shapes.end()) return nullptr;

    msdfgen::Shape &shape = *(it->second);

    // Edge coloring (only needed for MSDF and MTSDF)
    if (sdfMode >= 2) {
        switch (coloringMode) {
            default:
            case 0: msdfgen::edgeColoringSimple(shape, angleThreshold); break;
            case 1: msdfgen::edgeColoringInkTrap(shape, angleThreshold); break;
            case 2: msdfgen::edgeColoringByDistance(shape, angleThreshold); break;
        }
    }

    // Calculate projection: fit shape into bitmap with pxRange border
    msdfgen::Shape::Bounds bounds = shape.getBounds();

    double shapeW = bounds.r - bounds.l;
    double shapeH = bounds.t - bounds.b;

    if (shapeW <= 0 || shapeH <= 0) return nullptr;

    // Scale to fit shape into (width - 2*border) x (height - 2*border) pixels
    double border = pxRange;
    double usableW = width - 2.0 * border;
    double usableH = height - 2.0 * border;

    if (usableW <= 0 || usableH <= 0) return nullptr;

    double scaleX = usableW / shapeW;
    double scaleY = usableH / shapeH;
    double scale = scaleX < scaleY ? scaleX : scaleY;

    // Projection translation is expressed in shape units, not pixels.
    double translateX = -bounds.l + (width / scale - shapeW) * 0.5;
    double translateY = -bounds.b + (height / scale - shapeH) * 0.5;

    msdfgen::Projection projection(
        msdfgen::Vector2(scale, scale),
        msdfgen::Vector2(translateX, translateY)
    );

    msdfgen::Range distRange(pxRange / scale);
    const float sdfZeroValue = 0.5f;
    const msdfgen::FillRule fillRule = msdfgen::FILL_NONZERO;

    // Channel count per mode: SDF=1, PSDF=1, MSDF=3, MTSDF=4
    static const int channelCounts[] = { 1, 1, 3, 4 };
    int channels = (sdfMode >= 0 && sdfMode <= 3) ? channelCounts[sdfMode] : 4;
    int numFloats = width * height * channels;
    float *output = static_cast<float *>(malloc(numFloats * sizeof(float)));
    if (!output) return nullptr;

    switch (sdfMode) {
        case 0: { // SDF — single-channel true signed distance
            msdfgen::Bitmap<float, 1> bmp(width, height);
            msdfgen::GeneratorConfig cfg;
            msdfgen::generateSDF(bmp, shape, projection, distRange, cfg);
            msdfgen::distanceSignCorrection(bmp, shape, projection, sdfZeroValue, fillRule);
            for (int y = 0; y < height; ++y)
                for (int x = 0; x < width; ++x)
                    output[y * width + x] = bmp(x, y)[0];
            break;
        }
        case 1: { // PSDF — single-channel pseudo signed distance
            msdfgen::Bitmap<float, 1> bmp(width, height);
            msdfgen::GeneratorConfig cfg;
            msdfgen::generatePSDF(bmp, shape, projection, distRange, cfg);
            msdfgen::distanceSignCorrection(bmp, shape, projection, sdfZeroValue, fillRule);
            for (int y = 0; y < height; ++y)
                for (int x = 0; x < width; ++x)
                    output[y * width + x] = bmp(x, y)[0];
            break;
        }
        case 2: { // MSDF — multi-channel signed distance (3ch)
            msdfgen::Bitmap<float, 3> bmp(width, height);
            msdfgen::MSDFGeneratorConfig cfg;
            msdfgen::generateMSDF(bmp, shape, projection, distRange, cfg);
            msdfgen::distanceSignCorrection(bmp, shape, projection, sdfZeroValue, fillRule);
            for (int y = 0; y < height; ++y)
                for (int x = 0; x < width; ++x) {
                    int i = (y * width + x) * 3;
                    output[i]   = bmp(x, y)[0];
                    output[i+1] = bmp(x, y)[1];
                    output[i+2] = bmp(x, y)[2];
                }
            break;
        }
        default:
        case 3: { // MTSDF — multi-channel signed distance + true SDF (4ch)
            msdfgen::Bitmap<float, 4> bmp(width, height);
            msdfgen::MSDFGeneratorConfig cfg;
            msdfgen::generateMTSDF(bmp, shape, projection, distRange, cfg);
            msdfgen::distanceSignCorrection(bmp, shape, projection, sdfZeroValue, fillRule);
            for (int y = 0; y < height; ++y)
                for (int x = 0; x < width; ++x) {
                    int i = (y * width + x) * 4;
                    output[i]   = bmp(x, y)[0];
                    output[i+1] = bmp(x, y)[1];
                    output[i+2] = bmp(x, y)[2];
                    output[i+3] = bmp(x, y)[3];
                }
            break;
        }
    }

    g_lastBitmapW = width;
    g_lastBitmapH = height;

    return output;
}

EMSCRIPTEN_KEEPALIVE
void getBitmapSize(int *width, int *height) {
    if (width)  *width  = g_lastBitmapW;
    if (height) *height = g_lastBitmapH;
}

// === Cleanup ===

EMSCRIPTEN_KEEPALIVE
void destroyShape(int handle) {
    auto it = g_shapes.find(handle);
    if (it != g_shapes.end()) {
        delete it->second;
        g_shapes.erase(it);
    }
}

EMSCRIPTEN_KEEPALIVE
void destroyFont(int fontHandle) {
    auto it = g_fonts.find(fontHandle);
    if (it != g_fonts.end()) {
        msdfgen::destroyFont(it->second);
        g_fonts.erase(it);
    }
#ifdef MSDF_KIT_HARFBUZZ
    auto hit = g_hbFonts.find(fontHandle);
    if (hit != g_hbFonts.end()) {
        hb_font_destroy(hit->second);
        g_hbFonts.erase(hit);
    }
#endif
}

EMSCRIPTEN_KEEPALIVE
void destroyBitmap(float *ptr) {
    free(ptr);
}

} // extern "C"
