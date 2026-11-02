// 画合流 App 图标（1024×1024 PNG）：和看板左上角的品牌标一致——渐变圆角方块上两股线汇成一股，底下一层淡淡的工作台点阵。
// 用法：swiftc make-icon.swift -o make-icon && ./make-icon <输出.png>
import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

let size = 1024
let out = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "AppIcon-1024.png"
let cs = CGColorSpace(name: CGColorSpace.sRGB)!
let ctx = CGContext(data: nil, width: size, height: size, bitsPerComponent: 8, bytesPerRow: 0, space: cs,
                    bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!

func rgb(_ hex: UInt32, _ a: CGFloat = 1) -> CGColor {
  CGColor(srgbRed: CGFloat((hex >> 16) & 0xff) / 255, green: CGFloat((hex >> 8) & 0xff) / 255, blue: CGFloat(hex & 0xff) / 255, alpha: a)
}

// macOS 图标网格：824 的主体居中，四周留给阴影
let inset: CGFloat = 100
let body = CGRect(x: inset, y: inset, width: 1024 - inset * 2, height: 1024 - inset * 2)
let radius: CGFloat = 185
let shape = CGPath(roundedRect: body, cornerWidth: radius, cornerHeight: radius, transform: nil)

// 阴影
ctx.saveGState()
ctx.setShadow(offset: CGSize(width: 0, height: -14), blur: 34, color: rgb(0x1b1f4a, 0.38))
ctx.addPath(shape)
ctx.setFillColor(rgb(0x3f62ff))
ctx.fillPath()
ctx.restoreGState()

// 渐变主体（左上 → 右下；CG 的 y 轴朝上）
ctx.saveGState()
ctx.addPath(shape)
ctx.clip()
let grad = CGGradient(colorsSpace: cs, colors: [rgb(0x19b4e6), rgb(0x3f62ff), rgb(0x8b5cf6)] as CFArray, locations: [0, 0.55, 1])!
ctx.drawLinearGradient(grad, start: CGPoint(x: body.minX, y: body.maxY), end: CGPoint(x: body.maxX, y: body.minY), options: [])

// 工作台点阵
let unit = body.width / 32
ctx.setFillColor(rgb(0xffffff, 0.10))
var y = body.minY + unit
while y < body.maxY {
  var x = body.minX + unit
  while x < body.maxX {
    ctx.fillEllipse(in: CGRect(x: x - 5, y: y - 5, width: 10, height: 10))
    x += unit * 2
  }
  y += unit * 2
}

// 顶部一层柔光
let gloss = CGGradient(colorsSpace: cs, colors: [rgb(0xffffff, 0.22), rgb(0xffffff, 0)] as CFArray, locations: [0, 1])!
ctx.drawLinearGradient(gloss, start: CGPoint(x: 0, y: body.maxY), end: CGPoint(x: 0, y: body.midY), options: [])
ctx.restoreGState()

// 品牌标的线条：viewBox 32 → 主体
func p(_ x: CGFloat, _ y: CGFloat) -> CGPoint { CGPoint(x: body.minX + x * unit, y: body.maxY - y * unit) }
ctx.setLineCap(.round)
ctx.setLineWidth(2.4 * unit)
ctx.saveGState()
ctx.setShadow(offset: CGSize(width: 0, height: -6), blur: 18, color: rgb(0x0b0f2a, 0.25))
let lower = CGMutablePath()
lower.move(to: p(7, 23))
lower.addCurve(to: p(19, 16), control1: p(13, 23), control2: p(14, 16))
ctx.addPath(lower)
ctx.setStrokeColor(rgb(0xffffff, 0.75))
ctx.strokePath()
let upper = CGMutablePath()
upper.move(to: p(7, 9))
upper.addCurve(to: p(19, 16), control1: p(13, 9), control2: p(14, 16))
upper.addLine(to: p(25, 16))
ctx.addPath(upper)
ctx.setStrokeColor(rgb(0xffffff))
ctx.strokePath()
ctx.setFillColor(rgb(0xffffff))
let c = p(25, 16)
let r = 2.6 * unit
ctx.fillEllipse(in: CGRect(x: c.x - r, y: c.y - r, width: r * 2, height: r * 2))
ctx.restoreGState()

let img = ctx.makeImage()!
let dest = CGImageDestinationCreateWithURL(URL(fileURLWithPath: out) as CFURL, UTType.png.identifier as CFString, 1, nil)!
CGImageDestinationAddImage(dest, img, nil)
guard CGImageDestinationFinalize(dest) else { fatalError("写不出 \(out)") }
print(out)
