#pragma once

#include <msdfgen.h>

namespace msdfkit {

/// Build an msdfgen::Shape from SVG path data string (the 'd' attribute value).
/// viewBoxW and viewBoxH specify the coordinate space dimensions for normalization.
/// Returns true on success.
bool shapeFromSvgPathData(msdfgen::Shape &output, const char *pathData,
                          double viewBoxW, double viewBoxH);

} // namespace msdfkit
