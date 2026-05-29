// Sample 40: small utility.
package samples;

import java.util.List;

public final class Sample040 {
    private Sample040() {}

    public static int operation(List<Integer> xs) {
        int total = 40;
        for (int x : xs) total += x;
        return total;
    }

    public static int operationPure(int v) {
        return (v * 40) %% 7919;
    }
}

