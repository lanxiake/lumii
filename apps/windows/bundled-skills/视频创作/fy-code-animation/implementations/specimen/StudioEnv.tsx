import React, { useLayoutEffect } from "react";
import { useThree } from "@react-three/fiber";
import * as THREE from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";

export const StudioEnv: React.FC = () => {
  const { gl, scene } = useThree();
  useLayoutEffect(() => {
    const previous = scene.environment;
    const pm = new THREE.PMREMGenerator(gl);
    const room = new RoomEnvironment();
    const target = pm.fromScene(room, 0.04);
    scene.environment = target.texture;
    return () => {
      if (scene.environment === target.texture) scene.environment = previous;
      target.dispose();
      room.dispose();
      pm.dispose();
    };
  }, [gl, scene]);
  return null;
};
