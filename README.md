# LightSim

A local desktop tool for simulating LED light-pipe designs: import STEP revisions into a project, describe the LEDs,
materials and finishes, run a spectral Monte Carlo ray trace and look at exit-surface brightness, uniformity,
hotspots, colour mixing and the efficiency of getting light from the LEDs to that surface.

Everything runs on your computer. Projects and results are stored in a data folder (shown in Settings).

## Start

```powershell
.\start.ps1 -Setup    # first time: virtual environment, Python packages, UI build
.\start.ps1           # afterwards
```

It was developed with Python 3.13 and a recent Node (the UI is built once with `npm run build`). The packaged installer is built with
`.\packaging\build.ps1` (PyInstaller and Inno Setup).

## Releasing and updating

**Release:** push a tag (`git tag v0.2.0; git push origin v0.2.0`; a tag with a suffix such as `v0.3.0-beta.1` becomes a pre-release),
or run *Actions > Release installer* by hand with a version. The workflow (`.github/workflows/release.yml`) builds
`LightSim-Setup-<version>.exe` on a Windows runner and publishes it with its `.sha256` as a GitHub release. The version is
stamped into the build from the tag; nothing needs to be committed first. The *Bundle Mitsuba 3* option of the manual run adds
Render picture to the installer (several hundred MB).

**Update:** the app checks for a newer installer when it starts (switch off in *Settings > Updates*) and offers *Update now*.
The installer is downloaded, checked against its SHA-256 and run silently; the app restarts by itself. *Update source*
in the same place chooses where it looks:

- *GitHub releases* (default; the repository must be public), optionally including pre-releases.
- *A folder or web address of my own*: a local folder, a network share (`\\server\share\LightSim`) or `https://…`. It holds
  `LightSim-Setup-<version>.exe` (the highest version is offered, `.sha256` next to it is checked). `packaging\build.ps1` also
  writes `latest.json` (`version`, `file`, `sha256`, `notes`) into `dist-installer\`; a web address needs that file.

The installer is not code-signed, so Windows SmartScreen may warn when the installer is run by hand.

## Typical use

1. Drop a STEP file on the start page. A new project is created; later drops can be added to it, either as a new revision of
   a design or as a new **variant**. A variant is a design alternative (another LED spacing, reflector or light pipe) with its own
   setup; its revisions are successive edits of that one design. *New variant* (top bar, or the choice in the upload dialog) starts
   from a copy of another variant's setup and adapts it to the new geometry (LEDs added or removed, the "only LED n" states
   regenerated); *Adapt setup* does the same for an existing revision. Check the notes it shows.
2. **Auto-setup** suggests materials, the LED positions and the exit surface from the CAD. Check them and change what is wrong:
   parts get a material (for example *PC + 0.03 wt % TiO2*) and a finish, LEDs are placed by clicking the emitting face, the
   exit surface is picked by clicking faces, and *States* define which LEDs (or colour channels) are on.
3. **Run** a simulation. Quick looks use 200,000 rays per LED channel; use more for smooth colour maps.
4. Open a run to see efficiency, luminance map, uniformity, hotspots, colour, per-LED contributions and where the light went.
   *Map on model* drapes the map on the CAD, *Rays* shows recorded ray paths, *Compare* sets two runs side by side (maps), or lists any number of runs of the project, across variants, in one table with
   changes against a baseline run and overlaid profiles. A state that a variant does not have falls back to "All LEDs on".
   **Light path analysis** (saved runs only, kept for the first 2,000,000 rays per channel; the run settings `analysis` and `analysis_rays` change that): the *Groups* tab names the surfaces to analyse (by default every opaque face, the largest 62; you can also add faces of the light pipe). Under the map of an open run, *Surfaces* lists what share of the exit light left each surface last or touched it at all, how much it absorbs, and the footprint of its light on the exit surface; *Where does it come from?* takes a box or an outline on the exit map and breaks down the light landing there by last surface, LED, number of bounces and route; *Routes* groups all rays by the sequence of surfaces they touched; *What to change* shows the deficit map and a first-order estimate of how much each surface would have to send more or less light to the exit to flatten the map. Every list can send its rays to the 3D view (*Analysis* panel): the rays are traced again exactly, coloured by LED, remaining flux, bounce, event or surface, with a bounce slider, a glow (density) mode, and filters. In the *Surfaces* section of that panel you can click a face of the model to see what hits it, what it absorbs and where its light comes from and goes, or paint every face by the light it gets.
5. **Parameter sweep** repeats the run for several TiO2 loadings, particle sizes or scattering coefficients.
6. **Render picture** makes a camera view of the exit surface with Mitsuba 3. It uses an NVIDIA GPU (CUDA) when one works and falls back to the CPU otherwise; set `LIGHTSIM_MITSUBA_VARIANT=scalar_spectral` to force the CPU.
7. **Live** (toolbar above the 3D view) simulates the setup as it is in the editor, without a Run. Switch on *Physics*: the exit-surface map is drawn on the model within a few seconds and sharpens while more rays are traced; any edit of a part, LED, state or the library, or a move of the TiO2 slider (the setup is not changed), starts it again. The numbers shown are efficiency, min/max, hotspots, colour and CCT. *Keep* turns a finished preview into an ordinary run. *Photoreal view* draws the model lit by the simulated exit surface over the 3D view with the same camera, rendered by Mitsuba on the GPU; it refines while the camera is still and follows the simulation as it improves. While you orbit, the picture is hidden and the plain CAD view is shown, so positioning the camera is smooth; the picture comes back a moment after you let go. *Resolution* sets the size of the picture, from the size of the 3D view up to 4096 px along the long side; a bigger picture is sharper but each pass takes longer, so it needs more time to refine. *Studio light* sets a soft studio environment (a key light, a fill and a rim light that turn with the camera) as a fraction of the brightness of the exit surface; it lights the housing and shows reflections in the parts. The picture lights only the exit surface by default; choose *Full light transport* to let the LEDs light the whole model, so light leaking through the sides or glowing in the pipe is visible too. That mode is a plain path trace (the rays find the LEDs by chance): it is grainy at first and cleans up over many seconds while the camera is still, and its brightness is scaled to the exit surface of the simulation. Cuts and hidden parts are not shown in that picture. Live previews use coarser maps (at most 200 pixels per side) and are not listed under *Run*.

## What is modelled

- Light transport: Fresnel reflection and total internal reflection, Beckmann rough surfaces, opaque finishes (diffuse + specular),
  Beer-Lambert absorption, Henyey-Greenstein volume scattering, nested media, Russian roulette. Wavelength is traced per ray, so
  colour mixing and dispersion of scattering come out of the same run.
- LEDs: datasheet model (flux, spectrum, angular pattern, emitting area) per channel, or a measured text ray list.
- Diffuser: TiO2 in PC from Mie theory (particle size and loading), or fitted to a datasheet transmission and haze of a plaque.
- Exit surface: flat projection, or unwrapped (least squares conformal map) when strongly curved.

## Accuracy

The tool is meant for comparing designs ("relative accuracy"). Check absolute numbers against a measurement of one real part
before relying on them: LED binning, real diffuser scattering and surface texture are the largest uncertainties.

## Ray files

*Library, LEDs, Light source data, Measured ray set* reads a text file with one ray per line: `x y z l m n flux [wavelength_nm]`
(millimetres, direction cosines, +z along the emission axis). Binary and XML vendor formats (TM-25, Zemax DAT/SRC) must be
exported to this form first. IES and LDT files are intensity tables, not ray sets: enter them as a polar table.

## Tests

```powershell
cd server
..\.venv\Scripts\python.exe -m pytest tests -q
```

