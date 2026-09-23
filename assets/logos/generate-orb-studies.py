"""Original parametric contour-mark studies. Run with Python 3."""
from pathlib import Path
from math import sin, cos, pi
ROOT = Path(__file__).resolve().parents[2]

def project(x,y,z):
    a=.48
    xx=x*cos(a)+z*sin(a)
    zz=-x*sin(a)+z*cos(a)
    b=-.35
    yy=y*cos(b)-zz*sin(b)
    depth=y*sin(b)+zz*cos(b)
    return (120+xx*79,120+yy*79,depth)

def point(kind,u,v):
    if kind=='twisted-orb':
        # Uniform spherical body with open polar caps and evenly spaced ribs.
        # Retain the original openings without bulges or elongated poles.
        lat=-1.30+v*2.60
        r=cos(lat)
        angle=u+.85*sin(lat)
        return project(r*cos(angle),sin(lat),r*sin(angle))
    if kind=='folded-sphere':
        # Loops sweep an indented, three-lobed shell.
        lat=-1.38+v*2.76
        r=cos(lat)*(1+.23*cos(3*u+1.8*lat))
        angle=u+.5*lat
        return project(r*cos(angle),sin(lat)*.99+.10*cos(2*u)*cos(lat)**2,r*sin(angle))
    # Toroidal shell with an eccentric aperture, tilted into an orb silhouette.
    r=.68+.29*cos(v*2*pi)
    angle=u+.36*sin(v*2*pi)
    x=r*cos(angle)
    y=r*sin(angle)
    z=.45*sin(v*2*pi)+.15*sin(2*u)
    return project(x,y*.92,z)

def svg(kind,count):
    paths=[]
    # Rib curves are laid across the surface; painter order makes front ribs clear.
    for i in range(count):
        u=2*pi*i/count
        pts=[point(kind,u,j/180) for j in range(181)]
        depth=sum(p[2] for p in pts)/len(pts)
        d='M'+' L'.join(f'{x:.2f},{y:.2f}' for x,y,_ in pts)
        if kind=='looped-shell': d+=' Z'
        paths.append((depth,d))
    paths.sort()
    title=kind.replace('-',' ').title()
    body=''.join(f'<path d="{d}" opacity="{.48 if depth<0 else .95}"/>' for depth,d in paths)
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 240"><title>Alife — {title}</title><g fill="none" stroke="currentColor" stroke-width="{1.35 if count>20 else 2.2}" stroke-linecap="round" stroke-linejoin="round">{body}</g></svg>\n'

for kind in ['twisted-orb','folded-sphere','looped-shell']:
    for suffix,count in [('',42),('-small',16)]:
        name=f'logo-{kind}{suffix}.svg'
        content=svg(kind,count)
        for folder in [ROOT/'assets/logos',ROOT/'www/public/logos']:
            (folder/name).write_text(content)
