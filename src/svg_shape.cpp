#include "svg_shape.h"
#include <ext/import-svg.h>

namespace msdfkit {

bool shapeFromSvgPathData(msdfgen::Shape &output, const char *pathData,
                          double viewBoxW, double viewBoxH) {
    // Use msdfgen's built-in SVG path parser directly.
    // This does NOT require tinyxml2 — it parses the 'd' attribute string.
    double snapRange = 0;
    if (viewBoxW > 0 && viewBoxH > 0) {
        double dims = viewBoxW > viewBoxH ? viewBoxW : viewBoxH;
        snapRange = dims / 16384.0;
    }

    if (!msdfgen::buildShapeFromSvgPath(output, pathData, snapRange))
        return false;

    // Normalize: Y-axis flip (SVG is top-down, msdfgen expects bottom-up)
    output.normalize();

    return output.validate();
}

} // namespace msdfkit
