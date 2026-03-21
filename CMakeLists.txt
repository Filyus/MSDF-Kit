cmake_minimum_required(VERSION 3.15)
project(msdf-kit LANGUAGES CXX)

option(MSDF_KIT_HARFBUZZ "Enable HarfBuzz text shaping (layoutText)" ON)

# msdfgen options - configure before add_subdirectory
# CORE_ONLY: we compile ext sources (import-font, import-svg, resolve-shape-geometry)
# ourselves to avoid the tinyxml2 dependency while keeping buildShapeFromSvgPath.
set(MSDFGEN_CORE_ONLY ON CACHE BOOL "" FORCE)
set(MSDFGEN_BUILD_STANDALONE OFF CACHE BOOL "" FORCE)
set(MSDFGEN_USE_VCPKG OFF CACHE BOOL "" FORCE)
set(MSDFGEN_USE_OPENMP OFF CACHE BOOL "" FORCE)
set(MSDFGEN_USE_CPP11 ON CACHE BOOL "" FORCE)
set(MSDFGEN_USE_SKIA OFF CACHE BOOL "" FORCE)
set(MSDFGEN_INSTALL OFF CACHE BOOL "" FORCE)

# For Emscripten: FreeType and optional HarfBuzz are available as ports
if(EMSCRIPTEN)
    set(CMAKE_CXX_FLAGS "${CMAKE_CXX_FLAGS} -sUSE_FREETYPE=1")
    set(CMAKE_C_FLAGS "${CMAKE_C_FLAGS} -sUSE_FREETYPE=1")
    set(CMAKE_EXE_LINKER_FLAGS "${CMAKE_EXE_LINKER_FLAGS} -sUSE_FREETYPE=1")
    if(MSDF_KIT_HARFBUZZ)
        set(CMAKE_CXX_FLAGS "${CMAKE_CXX_FLAGS} -sUSE_HARFBUZZ=1")
        set(CMAKE_C_FLAGS "${CMAKE_C_FLAGS} -sUSE_HARFBUZZ=1")
        set(CMAKE_EXE_LINKER_FLAGS "${CMAKE_EXE_LINKER_FLAGS} -sUSE_HARFBUZZ=1")
    endif()
endif()

add_subdirectory(extern/msdfgen)

# Our WASM library
# We compile ext sources directly instead of linking msdfgen-ext, because:
# 1) We disabled SVG in msdfgen-ext to avoid tinyxml2 dep, but we need buildShapeFromSvgPath
# 2) buildShapeFromSvgPath doesn't need tinyxml2 — only the XML-based loadSvgShape does
add_executable(msdf-kit
    src/wrapper.cpp
    src/svg_shape.cpp
    extern/msdfgen/ext/import-svg.cpp
    extern/msdfgen/ext/import-font.cpp
    extern/msdfgen/ext/resolve-shape-geometry.cpp
)

target_include_directories(msdf-kit PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}/extern/msdfgen
)

# We intentionally do NOT define MSDFGEN_DISABLE_SVG so import-svg.h is usable.
# We do NOT define MSDFGEN_USE_TINYXML2 so tinyxml2 is not needed.
target_compile_definitions(msdf-kit PRIVATE
    MSDFGEN_EXT_PUBLIC=
    MSDFGEN_DISABLE_PNG
)

# Only link core, not ext (we compile ext sources ourselves)
target_link_libraries(msdf-kit PRIVATE msdfgen::msdfgen-core)

if(MSDF_KIT_HARFBUZZ)
    target_compile_definitions(msdf-kit PRIVATE MSDF_KIT_HARFBUZZ)
endif()

# Build exported function list; extend when optional features are enabled
set(MSDF_KIT_EXPORTS
    "_init" "_loadFont" "_shapeFromGlyph" "_getGlyphMetrics"
    "_getFontMetrics" "_getKerning" "_shapeFromSvgPath"
    "_getShapeBounds" "_generateMtsdf" "_getBitmapSize"
    "_destroyShape" "_destroyFont" "_destroyBitmap"
    "_shapeFromGlyphId" "_malloc" "_free"
)
if(MSDF_KIT_HARFBUZZ)
    list(APPEND MSDF_KIT_EXPORTS "_layoutText")
endif()
list(JOIN MSDF_KIT_EXPORTS "," MSDF_KIT_EXPORTS_STR)

if(EMSCRIPTEN)
    set_target_properties(msdf-kit PROPERTIES
        SUFFIX ".js"
        RUNTIME_OUTPUT_DIRECTORY "${CMAKE_CURRENT_SOURCE_DIR}/build"
    )

    target_link_options(msdf-kit PRIVATE
        -sWASM=1
        "-sEXPORTED_FUNCTIONS=[${MSDF_KIT_EXPORTS_STR}]"
        -sEXPORTED_RUNTIME_METHODS=["ccall","cwrap","UTF8ToString","stringToUTF8","getValue","setValue","HEAPU8","HEAPF32","HEAPF64"]
        -sALLOW_MEMORY_GROWTH=1
        -sMODULARIZE=1
        -sEXPORT_NAME=MsdfKitModule
        "SHELL:-s ENVIRONMENT='web,worker'"
        -sFILESYSTEM=0
        -sNO_EXIT_RUNTIME=1
        -O3
        --no-entry
    )
endif()
